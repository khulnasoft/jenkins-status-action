const core = require('@actions/core')
const github = require('@actions/github')
const exec = require('@actions/exec')
const { normalizeBoolean } = require('@ulisesgascon/normalize-boolean')
const { isDifferent } = require('@ulisesgascon/is-different')
const { updateOrCreateSegment } = require('@ulisesgascon/text-tags-manager')

const { existsSync } = require('fs')
const { readFile, writeFile, stat } = require('fs').promises

const {
  validateDatabaseIntegrity,
  generateReportContent,
  generateIssueDiskSpaceBodyContent
} = require('./utils')
const { processJenkinsData, downloadCurrentState } = require('./jenkins')

// most @actions toolkit packages have async methods
async function run () {
  try {
    let octokit
    // Context
    const context = github.context
    // Inputs
    const databasePath = core.getInput('database', { required: true })
    const jenkinsDomain = core.getInput('jenkins-domain', { required: true })
    const jenkinsUsername = core.getInput('jenkins-username', {
      required: true
    })
    const jenkinsToken = core.getInput('jenkins-token', { required: true })

    // Options
    const githubToken = core.getInput('github-token', { required: false })
    const reportTagsEnabled = normalizeBoolean(
      core.getInput('report-tags-enabled', { required: false })
    )
    const startTag =
      core.getInput('report-start-tag', { required: false }) ||
      '<!-- JENKINS-REPORTING:START -->'
    const endTag =
      core.getInput('report-end-tag', { required: false }) ||
      '<!-- JENKINS-REPORTING:END -->'
    const issueAssignees =
      core
        .getInput('issue-assignees', { required: false })
        .split(',')
        .filter(x => x !== '')
        .map(x => x.trim()) || []
    const issueLabels =
      core
        .getInput('issue-labels', { required: false })
        .split(',')
        .filter(x => x !== '')
        .map(x => x.trim()) || []
    const generateIssuesforUnkownNodes = normalizeBoolean(
      core.getInput('create-issues-for-new-offline-nodes', { required: false })
    )
    const generateIssue = normalizeBoolean(
      core.getInput('generate-issue', { required: false })
    )
    const reportPath = core.getInput('report', { required: false })
    const autoCommit = normalizeBoolean(
      core.getInput('auto-commit', { required: false })
    )
    const autoPush = normalizeBoolean(
      core.getInput('auto-push', { required: false })
    )
    const autoCloseIssue = normalizeBoolean(
      core.getInput('auto-close-issue', { required: false })
    )
    const diskAlertLevel =
      parseInt(core.getInput('disk-alert-level', { required: false })) || 0

    // Error Handling
    if (
      !githubToken &&
      [
        autoPush,
        autoCommit,
        generateIssue,
        autoCloseIssue,
        diskAlertLevel
      ].some(value => value)
    ) {
      throw new Error(
        'Github token is required for push, commit and create an issue operations!'
      )
    }

    if (githubToken) {
      octokit = github.getOctokit(githubToken)
    }

    let database = {}
    let originalReportContent = ''

    // == Recovering state ==
    // Check if database exists
    core.info('Checking if database exists...')
    const existDatabaseFile = existsSync(databasePath)
    if (existDatabaseFile) {
      database = await readFile(databasePath, 'utf8').then(content =>
        JSON.parse(content)
      )
      validateDatabaseIntegrity(database)
    } else {
      core.info('Database does not exist, creating new database')
    }

    // Check if report exists as the content will be used to update the report with the tags
    if (reportPath && reportTagsEnabled) {
      try {
        core.info('Checking if report exists...')
        await stat(reportPath)
        originalReportContent = await readFile(reportPath, 'utf8')
      } catch (error) {
        core.info(
          'Previous Report does not exist, ignoring previous content for tags...'
        )
      }
    }

    // == Process ==
    core.info('Getting data from Jenkins API...')
    const jenkinsData = await downloadCurrentState({
      jenkinsUsername,
      jenkinsToken,
      jenkinsDomain
    })

    core.info(`Total Machines in scope: ${jenkinsData.computer.length}`)
    if (!jenkinsData.computer.length) {
      core.setFailed('There are no available machines in Jenkins!')
    }

    core.info('Generating Report Data...')
    const { reportData, issuesData, newDatabaseState } = processJenkinsData({
      jenkinsData,
      database,
      jenkinsDomain,
      generateIssuesforUnkownNodes
    })
    const reportContent = generateReportContent({
      computers: reportData,
      jenkinsDomain,
      reportTagsEnabled
    })

    core.debug(`Report Content: ${reportContent}`)

    core.info('Checking database changes...')
    const hasChanges = isDifferent(database, newDatabaseState)

    if (!hasChanges) {
      core.info('No changes to database, skipping the rest of the process')
      return
    }

    // Save changes
    core.info('Saving changes to database and report')
    await writeFile(databasePath, JSON.stringify(newDatabaseState, null, 2))

    if (reportPath) {
      let content = reportContent
      if (reportTagsEnabled) {
        content = updateOrCreateSegment({
          original: originalReportContent,
          replacementSegment: reportContent,
          startTag,
          endTag
        })
      }
      await writeFile(reportPath, content)
    }

    // Commit changes
    // @see: https://github.com/actions/checkout#push-a-commit-using-the-built-in-token
    if (autoCommit) {
      core.info('Committing changes to database and report')
      await exec.exec('git config user.name github-actions[bot]')
      await exec.exec(
        'git config user.email github-actions[bot]@users.noreply.github.com'
      )
      await exec.exec(`git add ${databasePath}`)
      await exec.exec(`git add ${reportPath}`)
      await exec.exec('git commit -m "Updated Jenkins Status"')
    }

    // Push changes
    if (autoPush) {
      // @see: https://github.com/actions-js/push/blob/master/start.sh#L43
      core.info('Pushing changes to database and report')
      const remoteRepo = `https://${
        process.env.INPUT_GITHUB_ACTOR
      }:${githubToken}@github.com/${process.env.INPUT_REPOSITORY}.git`
      await exec.exec(
        `git push origin ${
          process.env.GITHUB_HEAD_REF
        } --force --no-verify --repo ${remoteRepo}`
      )
    }

    // Issue creation
    if (generateIssue && issuesData.length) {
      core.info('Creating the issues...')

      for await (const issueData of issuesData) {
        const { title, body } = issueData
        await octokit.rest.issues.create({
          ...context.repo,
          title,
          body,
          labels: issueLabels,
          assignees: issueAssignees
        })
      }

      core.info('Issues created!')
    }

    // List current issues open

    let issuesOpen = []
    if (autoCloseIssue || diskAlertLevel) {
      issuesOpen = await octokit.paginate(octokit.rest.issues.listForRepo, {
        ...context.repo,
        state: 'open',
        per_page: 100
      })

      core.info(`Total issues open: ${issuesOpen.length}`)
    }

    // Disk Alert
    if (diskAlertLevel) {
      core.info(
        `Checking for issues to close/open related to disk space with Disk usage level at (${diskAlertLevel}) or higher...`
      )
      for (const machine in newDatabaseState) {
        core.info(`Checking Disk alert for machine (${machine})...`)
        const issueRelatedToMachine = issuesOpen.find(
          issue =>
            issue.title ===
            `${newDatabaseState[machine].name} has low disk space`
        )
        // Open issue if disk usage is higher than the alert level
        if (
          newDatabaseState[machine].diskUsage >= diskAlertLevel &&
          !issueRelatedToMachine
        ) {
          core.info(`Generating issue for machine (${machine})...`)
          await octokit.rest.issues.create({
            ...context.repo,
            title: `${newDatabaseState[machine].name} has low disk space`,
            body: generateIssueDiskSpaceBodyContent(
              newDatabaseState[machine],
              jenkinsDomain
            ),
            labels: issueLabels,
            assignees: issueAssignees
          })
        }

        // Close issue if disk usage is lower than the alert level
        if (
          newDatabaseState[machine].diskUsage < diskAlertLevel &&
          issueRelatedToMachine
        ) {
          core.info(
            `Closing issue ${
              issueRelatedToMachine.number
            } for machine (${machine})...`
          )

          await octokit.rest.issues.createComment({
            ...context.repo,
            issue_number: issueRelatedToMachine.number,
            body: 'The machine has now enough disk space 🙌'
          })

          await octokit.rest.issues.update({
            ...context.repo,
            issue_number: issueRelatedToMachine.number,
            state: 'closed'
          })
        }
      }
    }
    // Issue closing
    if (autoCloseIssue) {
      core.info('Checking for issues to close...')
      if (issuesOpen.length) {
        for (const machine in newDatabaseState) {
          core.info(`Checking status for machine (${machine})...`)
          if (!newDatabaseState[machine].isOffline) {
            core.info(
              `Machine (${machine}) is online, checking if there is an issue to close...`
            )
            const issueToClose = issuesOpen.find(
              issue =>
                issue.title === `${newDatabaseState[machine].name} is DOWN`
            )
            if (issueToClose) {
              core.info(
                `Closing issue ${
                  issueToClose.number
                } for machine (${machine})...`
              )

              await octokit.rest.issues.createComment({
                ...context.repo,
                issue_number: issueToClose.number,
                body: 'The machine is now online again 🙌'
              })

              await octokit.rest.issues.update({
                ...context.repo,
                issue_number: issueToClose.number,
                state: 'closed'
              })
            }
          } else {
            core.info(`Machine ${machine} is not online, skipping...`)
          }
        }
      }
    }

    // SET OUTPUTS
    core.setOutput('computers', JSON.stringify(newDatabaseState))

    core.info('Process finished successfully! 🎉🎉🎉')
  } catch (error) {
    core.setFailed(error.message)
  }
}

run()
