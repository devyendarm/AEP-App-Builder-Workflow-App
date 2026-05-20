/**
 * workflow-status/index.js
 *
 * Reads current workflow state from AIO State.
 * Also acts as the active "crank" for asynchronous steps (like AEP QUERY)
 * which do not send Webhook/Event notifications. When queried, it checks the
 * status of active AEP queries and advances the workflow if they are complete.
 *
 * Params:
 *   runId  {string}  (Optional) The run ID to check. If omitted, uses the latest run ID.
 */

const { Core } = require('@adobe/aio-sdk')
const stateLib = require('@adobe/aio-lib-state')

async function main (params) {
  const logger = Core.Logger('workflow-status', { level: params.LOG_LEVEL || 'info' })

  try {
    const state = await stateLib.init()

    // Fetch run history (for the history table in the UI)
    const histEntry = await state.get('run_history')
    const runHistory = histEntry?.value || []

    // Resolve runId — use passed param or fall back to most recent run
    let runId = params.runId
    if (!runId) {
      const latest = await state.get('latest_run_id')
      if (!latest?.value) {
        return {
          statusCode: 200,
          body: { status: 'IDLE', message: 'No workflow has been run yet.', runHistory }
        }
      }
      runId = latest.value
    }

    const runEntry = await state.get(`workflow_run_${runId}`)
    if (!runEntry?.value) {
      return {
        statusCode: 200,
        body: { status: 'IDLE', runId, message: 'Run not found.', runHistory }
      }
    }

    let run = runEntry.value
    const { workflowSnapshot: workflow, currentStepIndex } = run
    const currentStep = workflow?.steps?.[currentStepIndex]

    // =========================================================================
    // ACTIVE CRANK: Check status of active Query Service jobs
    // =========================================================================
    if (
      run.status === 'IN_PROGRESS' &&
      currentStep?.type === 'QUERY' &&
      run.stepResults?.[currentStepIndex]?.status === 'ACTIVE'
    ) {
      const stepResult = run.stepResults[currentStepIndex]
      const queryId = stepResult.queryId

      if (queryId) {
        logger.info(`Checking AEP Query Service status for Job: ${queryId}`)
        
        let queryStatus = 'success' // Default to success if in demo mode
        let queryErrorMsg = null

        if (params.AEP_API_KEY && params.AEP_CLIENT_SECRET && !queryId.startsWith('demo_query_')) {
          try {
            const token = await getSystemAccessToken(params, logger)
            const queryRes = await fetch(`https://platform.adobe.io/data/foundation/query/queries/${queryId}`, {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${token}`,
                'x-api-key': params.AEP_API_KEY,
                'x-gw-ims-org-id': workflow.orgId,
                'x-sandbox-name': workflow.sandboxName
              }
            })
            if (queryRes.ok) {
              const queryData = await queryRes.json()
              const stateVal = queryData.state || 'failed'
              logger.info(`Query ${queryId} state: ${stateVal}`)
              
              if (stateVal === 'submitted' || stateVal === 'accepted' || stateVal === 'processing') {
                queryStatus = 'processing'
              } else if (stateVal === 'success') {
                queryStatus = 'success'
              } else {
                queryStatus = 'failed'
                queryErrorMsg = queryData.errors?.map(e => e.message).join('; ') || 'Query failed in AEP.'
              }
            } else {
              logger.warn(`Failed query status fetch: ${queryRes.status}`)
              queryStatus = 'processing' // Retry later
            }
          } catch (fetchErr) {
            logger.warn(`Fetch query status exception: ${fetchErr.message}`)
            queryStatus = 'processing'
          }
        }

        if (queryStatus === 'success') {
          logger.info(`Query step ${currentStepIndex} completed successfully. Advancing...`)
          run.stepResults[currentStepIndex] = {
            ...run.stepResults[currentStepIndex],
            status: 'COMPLETE',
            completedAt: new Date().toISOString()
          }

          const nextStepIndex = currentStepIndex + 1
          
          if (nextStepIndex >= workflow.steps.length) {
            logger.info(`All steps complete for run ${runId}.`)
            const completedAt = new Date().toISOString()
            run.status = 'COMPLETE'
            run.currentStepIndex = nextStepIndex
            run.lastUpdated = completedAt
            await state.put(`workflow_run_${runId}`, run, { ttl: 604800 })
            await syncHistory(state, runId, { status: 'COMPLETE', error: null, lastUpdated: completedAt })
          } else {
            // Execute sequential steps starting from nextStepIndex
            let currentIndex = nextStepIndex
            const MAX_RETRIES = 3
            while (currentIndex < workflow.steps.length) {
              const step = workflow.steps[currentIndex]
              logger.info(`Running pipeline step ${currentIndex}: ${step.type} — "${step.label}"`)

              run.stepResults[currentIndex] = { status: 'ACTIVE', startedAt: new Date().toISOString() }
              run.currentStepIndex = currentIndex
              run.status = 'IN_PROGRESS'
              run.lastUpdated = new Date().toISOString()
              await state.put(`workflow_run_${runId}`, run, { ttl: 604800 })

              try {
                const executeResult = await executeStep(step, workflow, runId, params, logger)

                if (step.type === 'QUERY') {
                  run.stepResults[currentIndex] = {
                    status: 'ACTIVE',
                    queryId: executeResult.queryId,
                    startedAt: run.stepResults[currentIndex].startedAt
                  }
                  run.lastUpdated = new Date().toISOString()
                  await state.put(`workflow_run_${runId}`, run, { ttl: 604800 })
                  logger.info(`Step ${currentIndex} (${step.type}) submitted. Query ID: ${executeResult.queryId}.`)
                  break
                }

                if (step.type === 'DESTINATION_FLOW') {
                  run.stepResults[currentIndex] = {
                    status: 'ACTIVE',
                    startedAt: run.stepResults[currentIndex].startedAt
                  }
                  run.lastUpdated = new Date().toISOString()
                  await state.put(`workflow_run_${runId}`, run, { ttl: 604800 })
                  logger.info(`Step ${currentIndex} (${step.type}) triggered. Waiting for FlowRunSucceeded event...`)
                  break
                }

                // Synchronous step completion
                run.stepResults[currentIndex] = { status: 'COMPLETE', completedAt: new Date().toISOString() }
                currentIndex++

                if (currentIndex >= workflow.steps.length) {
                  const completedAt = new Date().toISOString()
                  run.status = 'COMPLETE'
                  run.currentStepIndex = currentIndex
                  run.lastUpdated = completedAt
                  await state.put(`workflow_run_${runId}`, run, { ttl: 604800 })
                  await syncHistory(state, runId, { status: 'COMPLETE', error: null, lastUpdated: completedAt })
                } else {
                  run.stepResults[currentIndex] = { status: 'PENDING' }
                  run.currentStepIndex = currentIndex
                  run.lastUpdated = new Date().toISOString()
                  await state.put(`workflow_run_${runId}`, run, { ttl: 604800 })
                }

              } catch (stepError) {
                logger.error(`Step ${currentIndex} (${step.type}) failed: ${stepError.message}`)
                const retryCount = (run.retryCount || 0) + 1
                const isRetryable = retryCount < MAX_RETRIES
                run.stepResults[currentIndex] = { status: 'ERROR', error: stepError.message }

                const finalStatus = isRetryable ? 'FAILED_RETRYABLE' : 'FAILED_PERMANENT'
                const updatedTime = new Date().toISOString()
                run.status = finalStatus
                run.currentStepIndex = currentIndex
                run.retryCount = retryCount
                run.failedStepIndex = currentIndex
                run.error = stepError.message
                run.lastUpdated = updatedTime
                await state.put(`workflow_run_${runId}`, run, { ttl: 604800 })
                await syncHistory(state, runId, { status: finalStatus, error: stepError.message, lastUpdated: updatedTime })
                break
              }
            }
          }
        } else if (queryStatus === 'failed') {
          logger.error(`Query step ${currentStepIndex} failed: ${queryErrorMsg}`)
          run.stepResults[currentStepIndex] = {
            ...run.stepResults[currentStepIndex],
            status: 'ERROR',
            error: queryErrorMsg || 'Query execution failed in AEP.'
          }

          const MAX_RETRIES = 3
          const retryCount = (run.retryCount || 0) + 1
          const isRetryable = retryCount < MAX_RETRIES
          const finalStatus = isRetryable ? 'FAILED_RETRYABLE' : 'FAILED_PERMANENT'
          const updatedTime = new Date().toISOString()

          run.status = finalStatus
          run.retryCount = retryCount
          run.failedStepIndex = currentStepIndex
          run.error = queryErrorMsg || 'Query execution failed in AEP.'
          run.lastUpdated = updatedTime

          await state.put(`workflow_run_${runId}`, run, { ttl: 604800 })
          await syncHistory(state, runId, { status: finalStatus, error: run.error, lastUpdated: updatedTime })
        }
      }
    }

    return {
      statusCode: 200,
      body: {
        runId,
        status: run.status,
        campaignName: run.campaignName,
        fileName: run.fileName,
        batchId: run.batchId,
        workflowName: run.workflowSnapshot?.workflowName,
        steps: run.workflowSnapshot?.steps || [],
        stepResults: run.stepResults || {},
        currentStepIndex: run.currentStepIndex,
        retryCount: run.retryCount || 0,
        error: run.error || null,
        failedStepIndex: run.failedStepIndex,
        startedAt: run.startedAt,
        lastUpdated: run.lastUpdated,
        runHistory    // Last 10 runs for the history table
      }
    }

  } catch (error) {
    logger.error(`workflow-status error: ${error.message}`)
    return { statusCode: 500, body: { error: 'Status check failed.', details: error.message } }
  }
}

// =============================================================================
// Step executor — handles all step types dynamically
// =============================================================================
async function executeStep (step, workflow, runId, params, logger) {
  const { orgId, sandboxName } = workflow

  // Retrieve system access token dynamically (fallback to empty if credentials missing)
  let token = ''
  if (params.AEP_API_KEY && params.AEP_CLIENT_SECRET) {
    try {
      token = await getSystemAccessToken(params, logger)
    } catch (e) {
      logger.error('Failed to resolve system access token: ' + e.message)
    }
  }

  // AEP service-to-server headers
  const getAepHeaders = (contentType = 'application/json') => ({
    'Authorization': `Bearer ${token}`,
    'x-api-key': params.AEP_API_KEY || '',
    'x-gw-ims-org-id': orgId,
    'x-sandbox-name': sandboxName,
    'Content-Type': contentType
  })

  switch (step.type) {
    case 'INGEST':
      logger.info('INGEST step — already processed by file-router. Marking complete.')
      return { skipped: true }

    case 'QUERY': {
      if (!token || !params.AEP_API_KEY) {
        logger.warn('AEP credentials/token not set — QUERY step running in demo mode (no real query submitted).')
        return { demo: true, queryId: `demo_query_${Date.now()}`, message: 'Add AEP_CLIENT_SECRET and AEP_API_KEY to Workspace Secrets to enable real query execution.' }
      }
      if (!step.config.templateId) {
        throw new Error('QUERY step requires config.templateId.')
      }
      logger.info(`Submitting Query Template: ${step.config.templateId}`)
      const queryRes = await fetch('https://platform.adobe.io/data/foundation/query/queries', {
        method: 'POST',
        headers: getAepHeaders(),
        body: JSON.stringify({
          dbName: `${sandboxName}:all`,
          templateId: step.config.templateId,
          name: step.config.queryName || `Workflow Query ${Date.now()}`
        })
      })
      if (!queryRes.ok) throw new Error(`AEP Query Service: ${queryRes.status} - ${await queryRes.text()}`)
      const queryData = await queryRes.json()
      return { queryId: queryData.id }
    }

    case 'DESTINATION_FLOW': {
      logger.info(`Triggering Destination Flow: ${step.config.flowId}`)
      if (!token || !params.AEP_API_KEY) {
        logger.warn('AEP credentials/token not configured — DESTINATION_FLOW step skipped in demo mode.')
        return { demo: true, message: 'Configure AEP_CLIENT_SECRET and AEP_API_KEY to enable real flow runs.' }
      }
      
      const state = await stateLib.init()
      await state.put(`run_by_flow_${step.config.flowId}`, { runId }, { ttl: 604800 })

      const flowRes = await fetch('https://platform.adobe.io/data/foundation/flowservice/runs', {
        method: 'POST',
        headers: getAepHeaders(),
        body: JSON.stringify({ flowId: step.config.flowId })
      })
      if (!flowRes.ok) throw new Error(`AEP Flow Service: ${flowRes.status} - ${await flowRes.text()}`)
      return { triggered: true }
    }

    case 'EXTERNAL_API': {
      logger.info(`Calling External API: ${step.config.apiUrl}`)
      if (!step.config.apiUrl) throw new Error('EXTERNAL_API step requires config.apiUrl.')
      const apiRes = await fetch(step.config.apiUrl, {
        method: step.config.method || 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId, timestamp: new Date().toISOString() })
      })
      if (!apiRes.ok) throw new Error(`External API returned status ${apiRes.status}`)
      return { success: true }
    }

    default:
      throw new Error(`Unknown step type: ${step.type}`)
  }
}

// =============================================================================
// History synchronization helper
// =============================================================================
async function syncHistory (state, runId, updates) {
  try {
    const runEntry = await state.get(`workflow_run_${runId}`)
    if (!runEntry?.value) return

    const run = runEntry.value
    const histEntry = await state.get('run_history')
    let history = histEntry?.value || []

    const index = history.findIndex(h => h.runId === runId)
    if (index !== -1) {
      history[index] = {
        ...history[index],
        status: updates.status,
        error: updates.error || null,
        lastUpdated: updates.lastUpdated || new Date().toISOString()
      }
    } else {
      history.unshift({
        runId,
        campaignName: run.campaignName,
        fileName: run.fileName,
        status: updates.status,
        error: updates.error || null,
        startedAt: run.startedAt,
        lastUpdated: updates.lastUpdated || new Date().toISOString()
      })
    }

    if (history.length > 10) history = history.slice(0, 10)
    await state.put('run_history', history, { ttl: 31536000 })
  } catch (e) {
    console.warn('syncHistory failed:', e.message)
  }
}

async function getSystemAccessToken(params, logger) {
  const state = await stateLib.init()
  const cacheKey = 'system_ims_access_token'

  // 1. Try AIO State cache first
  try {
    const cached = await state.get(cacheKey)
    if (cached?.value) {
      logger.info('Using cached System Access Token.')
      return cached.value
    }
  } catch (e) {
    logger.warn('Cache lookup failed (non-critical): ' + e.message)
  }

  // 2. Fallback: Request a fresh token from Adobe IMS
  if (!params.AEP_API_KEY || !params.AEP_CLIENT_SECRET) {
    throw new Error('AEP_API_KEY or AEP_CLIENT_SECRET is missing from workspace configuration.')
  }

  logger.info('Requesting fresh System Access Token from Adobe IMS...')
  
  const response = await fetch('https://ims-na1.adobelogin.com/ims/token/v3', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: params.AEP_API_KEY,
      client_secret: params.AEP_CLIENT_SECRET,
      scope: 'openid,AdobeID,read_organizations,additional_info.project_roles'
    })
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`IMS Token Generation Failed (${response.status}): ${errText}`)
  }

  const data = await response.json()
  const accessToken = data.access_token

  if (!accessToken) {
    throw new Error('IMS Token Generation Response did not contain an access_token.')
  }

  // 3. Cache the token (expires in 23 hours to stay safe)
  try {
    await state.put(cacheKey, accessToken, { ttl: 82800 })
    logger.info('Cached fresh System Access Token.')
  } catch (e) {
    logger.warn('Cache storage failed (non-critical): ' + e.message)
  }

  return accessToken
}

exports.main = main
