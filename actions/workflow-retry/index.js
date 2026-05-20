/**
 * workflow-retry/index.js
 *
 * Called from the React UI Retry button when a run is in FAILED_RETRYABLE state.
 * Resets the failed step and all subsequent steps to PENDING, marks the failed step ACTIVE,
 * and immediately triggers execution using the sequential execution loop.
 *
 * Params:
 *   runId (optional) — defaults to the most recent run (latest_run_id)
 */

const { Core } = require('@adobe/aio-sdk')
const stateLib = require('@adobe/aio-lib-state')

const MAX_RETRIES = 3

async function main (params) {
  const logger = Core.Logger('workflow-retry', { level: params.LOG_LEVEL || 'info' })

  try {
    const state = await stateLib.init()

    // Resolve runId — use passed param or fall back to most recent run
    let runId = params.runId
    if (!runId) {
      const latest = await state.get('latest_run_id')
      if (!latest?.value) {
        return { statusCode: 404, body: { error: 'No recent workflow run found to retry.' } }
      }
      runId = latest.value
    }

    const runEntry = await state.get(`workflow_run_${runId}`)
    if (!runEntry?.value) {
      return { statusCode: 404, body: { error: `Run not found: ${runId}` } }
    }

    const run = runEntry.value
    const retryCount = (run.retryCount || 0) + 1

    logger.info(`Retry #${retryCount} for run ${runId} | Status: ${run.status} | Failed step: ${run.failedStepIndex}`)

    // =========================================================================
    // Guards
    // =========================================================================
    if (run.status === 'COMPLETE') {
      return { statusCode: 400, body: { error: 'Workflow already completed. Nothing to retry.' } }
    }

    if (run.status === 'FAILED_PERMANENT') {
      return { statusCode: 400, body: { error: `Workflow has permanently failed after ${MAX_RETRIES} attempts. Please contact your administrator.` } }
    }

    if (run.status === 'FAILED_INGESTION') {
      return {
        statusCode: 400,
        body: {
          error: 'INGESTION_FAILURE_REQUIRES_REUPLOAD',
          message: 'AEP rejected the batch ingestion — this is usually a CSV data format issue (wrong column names, bad date format, missing required fields). Please fix your CSV file and re-upload it to start a new run.'
        }
      }
    }

    if (retryCount > MAX_RETRIES) {
      const updatedTime = new Date().toISOString()
      const failedIdx = run.failedStepIndex || 0
      const finalRun = {
        ...run, status: 'FAILED_PERMANENT', retryCount, lastUpdated: updatedTime
      }
      await state.put(`workflow_run_${runId}`, finalRun, { ttl: 604800 })
      await syncHistory(state, runId, { status: 'FAILED_PERMANENT', error: `Max retries (${MAX_RETRIES}) reached.`, lastUpdated: updatedTime })
      return { statusCode: 400, body: { error: `Max retries (${MAX_RETRIES}) reached. Workflow marked as permanently failed.` } }
    }

    // =========================================================================
    // Retry Execution
    // =========================================================================
    const failedIdx = run.failedStepIndex
    if (failedIdx === null || failedIdx === undefined) {
      return { statusCode: 400, body: { error: 'Could not identify which step failed. Please re-upload the file to start a fresh run.' } }
    }

    const workflow = run.workflowSnapshot
    const failedStep = workflow?.steps?.[failedIdx]
    if (!failedStep) {
      return { statusCode: 400, body: { error: `Step at index ${failedIdx} not found in workflow definition.` } }
    }

    logger.info(`Resetting step ${failedIdx} (${failedStep.type}: "${failedStep.label}") for retry #${retryCount}`)

    // Reset step results for failed step and all subsequent steps
    const stepResults = { ...run.stepResults }
    for (let i = failedIdx; i < (workflow.steps?.length || 0); i++) {
      stepResults[i] = { status: 'PENDING' }
    }

    run.stepResults = stepResults
    run.retryCount = retryCount
    run.error = null
    run.failedStepIndex = null

    // Execute sequential steps starting from failedIdx
    let currentIndex = failedIdx
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
        const nextRetryCount = run.retryCount // Keep current retry count
        const isRetryable = nextRetryCount < MAX_RETRIES
        run.stepResults[currentIndex] = { status: 'ERROR', error: stepError.message }

        const finalStatus = isRetryable ? 'FAILED_RETRYABLE' : 'FAILED_PERMANENT'
        const updatedTime = new Date().toISOString()
        run.status = finalStatus
        run.currentStepIndex = currentIndex
        run.failedStepIndex = currentIndex
        run.error = stepError.message
        run.lastUpdated = updatedTime
        await state.put(`workflow_run_${runId}`, run, { ttl: 604800 })
        await syncHistory(state, runId, { status: finalStatus, error: stepError.message, lastUpdated: updatedTime })
        break
      }
    }

    return {
      statusCode: 200,
      body: {
        message: `Retry #${retryCount} initiated for step "${failedStep.label}" (${failedStep.type}).`,
        retryCount,
        stepType: failedStep.type,
        stepLabel: failedStep.label
      }
    }

  } catch (error) {
    logger.error(`workflow-retry error: ${error.message}`)
    return { statusCode: 500, body: { error: 'Retry action failed.', details: error.message } }
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
