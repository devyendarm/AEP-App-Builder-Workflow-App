/**
 * event-orchestrator/index.js
 *
 * Triggered by Adobe I/O Events (AEP Source Flow Run Succeeded/Failed).
 * Reads the in-flight run state from AIO State, determines the next step,
 * and executes it. Supports any step sequence: INGEST, QUERY,
 * DESTINATION_FLOW, EXTERNAL_API — in any order.
 *
 * Step execution strategy:
 *   INGEST           — triggered externally (file-router). Orchestrator marks it complete.
 *   QUERY            — POST to AEP Query Service (fire-and-forget; advances state immediately)
 *   DESTINATION_FLOW — POST to AEP Flow Service runs (fire-and-forget)
 *   EXTERNAL_API     — HTTP fetch (synchronous, no auth for MVP)
 *
 * Production note: QUERY and DESTINATION_FLOW steps require a service-to-service
 * OAuth token (SERVICE_TOKEN + AEP_API_KEY in Workspace Secrets). The API call
 * blocks are clearly marked for enabling once credentials are configured.
 */

const { Core } = require('@adobe/aio-sdk')
const stateLib = require('@adobe/aio-lib-state')

const MAX_RETRIES = 3

async function main (params) {
  const logger = Core.Logger('event-orchestrator', { level: params.LOG_LEVEL || 'info' })

  try {
    // =========================================================================
    // STEP 0: Webhook Challenge (REQUIRED for Adobe I/O Events registration)
    // =========================================================================
    if (params.__ow_method === 'GET' && params.challenge) {
      logger.info('Webhook challenge received.')
      return { statusCode: 200, body: { challenge: params.challenge } }
    }

    logger.info('Event Orchestrator triggered.')

    // =========================================================================
    // =========================================================================
    // STEP 1: Parse incoming AEP event — extract datasetId or flowId
    // =========================================================================
    const eventPayload = params.event || params
    const eventType = eventPayload['xdm:eventType'] || eventPayload.type || 'unknown'
    
    const datasetId =
      eventPayload?.body?.xdmEntity?.datasetId ||
      eventPayload?.xdmEntity?.datasetId ||
      eventPayload?.event?.['xdm:datasetId'] ||
      eventPayload?.datasetId || null

    const flowId =
      eventPayload?.body?.xdmEntity?.flowId ||
      eventPayload?.xdmEntity?.flowId ||
      eventPayload?.event?.['xdm:flowId'] ||
      eventPayload?.flowId || null

    logger.info(`Event: ${eventType} | Dataset: ${datasetId} | Flow: ${flowId}`)

    if (!datasetId && !flowId) {
      logger.warn('Could not extract datasetId or flowId. Raw params: ' + JSON.stringify(params, null, 2))
      return { statusCode: 200, body: { message: 'Neither datasetId nor flowId found in event. Check logs.' } }
    }

    // =========================================================================
    // STEP 2: Resolve the active run for this dataset or flow
    // =========================================================================
    const state = await stateLib.init()
    let runId = null

    if (datasetId) {
      const routingEntry = await state.get(`run_by_dataset_${datasetId}`)
      if (routingEntry?.value?.runId) {
        runId = routingEntry.value.runId
      }
    }

    if (!runId && flowId) {
      const routingEntry = await state.get(`run_by_flow_${flowId}`)
      if (routingEntry?.value?.runId) {
        runId = routingEntry.value.runId
      }
    }

    if (!runId) {
      logger.info(`No active run found for dataset ${datasetId} or flow ${flowId}. Ignoring.`)
      return { statusCode: 200, body: { message: 'No active run for this event.' } }
    }
    const runEntry = await state.get(`workflow_run_${runId}`)

    if (!runEntry?.value) {
      logger.warn(`Run state not found for runId ${runId}.`)
      return { statusCode: 200, body: { message: 'Run state not found.' } }
    }

    const run = runEntry.value
    const { workflowSnapshot: workflow, currentStepIndex } = run
    logger.info(`Run: ${runId} | Campaign: "${run.campaignName}" | Step: ${currentStepIndex}/${workflow.steps.length - 1}`)

    // =========================================================================
    // STEP 3: Handle FAILURE event
    // =========================================================================
    if (eventType.includes('Failed') || eventType.includes('FlowRunFailed')) {
      logger.error(`AEP Flow Run FAILED for run ${runId}.`)
      const stepResults = { ...run.stepResults }
      stepResults[currentStepIndex] = { status: 'ERROR', error: 'AEP flow run execution failed.', completedAt: new Date().toISOString() }

      const updated = {
        ...run, status: 'FAILED_PERMANENT', failedStepIndex: currentStepIndex, stepResults,
        error: `AEP Flow Run failed at ${new Date().toISOString()}. Check AEP Flow Service logs.`,
        lastUpdated: new Date().toISOString()
      }
      await state.put(`workflow_run_${runId}`, updated, { ttl: 604800 })
      await syncHistory(state, runId, { status: 'FAILED_PERMANENT', error: updated.error, lastUpdated: updated.lastUpdated })
      return { statusCode: 200, body: { message: 'Failure event recorded.' } }
    }

    // =========================================================================
    // STEP 4: Handle SUCCESS — mark current step complete, advance to next
    // =========================================================================
    if (eventType.includes('Succeeded') || eventType.includes('FlowRunSucceeded')) {

      // Mark current step COMPLETE
      const stepResults = { ...run.stepResults }
      stepResults[currentStepIndex] = { status: 'COMPLETE', completedAt: new Date().toISOString() }

      const nextStepIndex = currentStepIndex + 1

      // All steps done?
      if (nextStepIndex >= workflow.steps.length) {
        logger.info(`All steps complete for run ${runId}.`)
        const completedAt = new Date().toISOString()
        await state.put(`workflow_run_${runId}`, {
          ...run, status: 'COMPLETE', stepResults, currentStepIndex: nextStepIndex,
          lastUpdated: completedAt
        }, { ttl: 604800 })
        await syncHistory(state, runId, { status: 'COMPLETE', error: null, lastUpdated: completedAt })
        return { statusCode: 200, body: { message: 'Workflow complete.' } }
      }

      // Execute sequential steps starting from nextStepIndex
      let currentIndex = nextStepIndex
      while (currentIndex < workflow.steps.length) {
        const step = workflow.steps[currentIndex]
        logger.info(`Running pipeline step ${currentIndex}: ${step.type} — "${step.label}"`)

        stepResults[currentIndex] = { status: 'ACTIVE', startedAt: new Date().toISOString() }
        
        // Save status before execution (so UI sees ACTIVE immediately)
        await state.put(`workflow_run_${runId}`, {
          ...run, status: 'IN_PROGRESS', currentStepIndex: currentIndex, stepResults,
          lastUpdated: new Date().toISOString()
        }, { ttl: 604800 })

        // Propagation delay before Query step
        if (step.type === 'QUERY') {
          logger.info('Waiting 10s for AEP data propagation...')
          await new Promise(resolve => setTimeout(resolve, 10000))
        }

        try {
          const stepResult = await executeStep(step, workflow, runId, params, logger)

          if (step.type === 'QUERY') {
            // Asynchronous: store queryId and pause execution. Polling will check query status.
            stepResults[currentIndex] = {
              status: 'ACTIVE',
              queryId: stepResult.queryId,
              startedAt: stepResults[currentIndex].startedAt
            }
            await state.put(`workflow_run_${runId}`, {
              ...run, status: 'IN_PROGRESS', currentStepIndex: currentIndex, stepResults,
              lastUpdated: new Date().toISOString()
            }, { ttl: 604800 })
            logger.info(`Step ${currentIndex} (${step.type}) submitted. Query ID: ${stepResult.queryId}. Waiting for completion...`)
            break
          }

          if (step.type === 'DESTINATION_FLOW') {
            // Asynchronous: wait for FlowRunSucceeded event.
            stepResults[currentIndex] = {
              status: 'ACTIVE',
              startedAt: stepResults[currentIndex].startedAt
            }
            await state.put(`workflow_run_${runId}`, {
              ...run, status: 'IN_PROGRESS', currentStepIndex: currentIndex, stepResults,
              lastUpdated: new Date().toISOString()
            }, { ttl: 604800 })
            logger.info(`Step ${currentIndex} (${step.type}) triggered. Waiting for FlowRunSucceeded event...`)
            break
          }

          // Synchronous/Immediate steps
          stepResults[currentIndex] = { status: 'COMPLETE', completedAt: new Date().toISOString() }
          currentIndex++

          if (currentIndex >= workflow.steps.length) {
            logger.info(`All steps complete for run ${runId}.`)
            const completedAt = new Date().toISOString()
            await state.put(`workflow_run_${runId}`, {
              ...run, status: 'COMPLETE', stepResults, currentStepIndex: currentIndex,
              lastUpdated: completedAt
            }, { ttl: 604800 })
            await syncHistory(state, runId, { status: 'COMPLETE', error: null, lastUpdated: completedAt })
          } else {
            stepResults[currentIndex] = { status: 'PENDING' }
            await state.put(`workflow_run_${runId}`, {
              ...run, status: 'IN_PROGRESS', currentStepIndex: currentIndex, stepResults,
              lastUpdated: new Date().toISOString()
            }, { ttl: 604800 })
          }

        } catch (stepError) {
          logger.error(`Step ${currentIndex} (${step.type}) failed: ${stepError.message}`)
          const retryCount = (run.retryCount || 0) + 1
          const isRetryable = retryCount < MAX_RETRIES
          stepResults[currentIndex] = { status: 'ERROR', error: stepError.message }

          const finalStatus = isRetryable ? 'FAILED_RETRYABLE' : 'FAILED_PERMANENT'
          const updatedTime = new Date().toISOString()
          await state.put(`workflow_run_${runId}`, {
            ...run, status: finalStatus,
            currentStepIndex: currentIndex, stepResults, retryCount,
            failedStepIndex: currentIndex, error: stepError.message,
            lastUpdated: updatedTime
          }, { ttl: 604800 })
          await syncHistory(state, runId, { status: finalStatus, error: stepError.message, lastUpdated: updatedTime })
          break
        }
      }
    }

    return { statusCode: 200, body: { message: 'Event processed.', runId, eventType } }

  } catch (error) {
    logger.error(`Event Orchestrator Error: ${error.message}`)
    return { statusCode: 500, body: { error: 'Event processing failed.', details: error.message } }
  }
}


// =============================================================================
// syncHistory — updates the run_history entry for a completed/failed run
// =============================================================================
async function syncHistory (state, runId, update) {
  try {
    const histEntry = await state.get('run_history')
    const history = histEntry?.value || []
    const idx = history.findIndex(r => r.runId === runId)
    if (idx >= 0) {
      history[idx] = { ...history[idx], ...update }
      await state.put('run_history', history, { ttl: 2592000 })
    }
  } catch (e) {
    // Non-critical — don't let history update failure affect the main flow
    console.warn('syncHistory failed (non-critical):', e.message)
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
      // INGEST is triggered by the user uploading a file (file-router).
      // If orchestrator reaches an INGEST step it means it was already handled.
      logger.info('INGEST step — already processed by file-router. Marking complete.')
      return { skipped: true }

    case 'QUERY': {
      // Runs a saved AEP Query Service Template by ID.
      // Templates are created in AEP (Query Service → Templates) and referenced here by ID.
      // This is the scalable approach — SQL is managed in AEP, not hardcoded in this app.
      // Requires SERVICE_TOKEN + AEP_API_KEY in Adobe Workspace Secrets.

      if (!token || !params.AEP_API_KEY) {
        logger.warn('AEP credentials/token not set — QUERY step running in demo mode (no real query submitted).')
        return { demo: true, queryId: `demo_query_${Date.now()}`, message: 'Add AEP_CLIENT_SECRET and AEP_API_KEY to Workspace Secrets to enable real query execution.' }
      }

      if (!step.config.templateId) {
        throw new Error(
          'QUERY step requires config.templateId. ' +
          'Go to AEP → Query Service → Templates, create or find your template, and copy its ID into the workflow steps JSON.'
        )
      }

      logger.info(`Submitting Query Template: ${step.config.templateId} ("${step.config.queryName || 'unnamed'}")`)

      const queryRes = await fetch('https://platform.adobe.io/data/foundation/query/queries', {
        method: 'POST',
        headers: getAepHeaders(),
        body: JSON.stringify({
          dbName: `${sandboxName}:all`,
          templateId: step.config.templateId,         // Reference saved template — no inline SQL
          name: step.config.queryName || `Workflow Query ${Date.now()}`
        })
      })
      if (!queryRes.ok) throw new Error(`AEP Query Service: ${queryRes.status} - ${await queryRes.text()}`)
      const queryData = await queryRes.json()
      logger.info(`Query job submitted. Job ID: ${queryData.id} | Template: ${step.config.templateId}`)
      return { queryId: queryData.id, templateId: step.config.templateId }
    }


    case 'DESTINATION_FLOW': {
      // Trigger an AEP Flow Service destination run
      logger.info(`Triggering Destination Flow: ${step.config.flowId}`)

      if (!token || !params.AEP_API_KEY) {
        logger.warn('AEP credentials/token not configured — DESTINATION_FLOW step skipped in demo mode.')
        return { demo: true, message: 'Configure AEP_CLIENT_SECRET and AEP_API_KEY to enable real flow runs.' }
      }

      // Store routing key so event-orchestrator can find this run when flow completes
      const state = await stateLib.init()
      await state.put(`run_by_flow_${step.config.flowId}`, { runId }, { ttl: 604800 })

      const flowRes = await fetch('https://platform.adobe.io/data/foundation/flowservice/runs', {
        method: 'POST',
        headers: getAepHeaders(),
        body: JSON.stringify({ flowId: step.config.flowId })
      })
      if (!flowRes.ok) throw new Error(`AEP Flow Service: ${flowRes.status} - ${await flowRes.text()}`)
      logger.info('Destination flow triggered successfully.')
      return { triggered: true }
    }

    case 'EXTERNAL_API': {
      // Plain HTTP call — no auth (MVP)
      logger.info(`Calling External API: ${step.config.method || 'POST'} ${step.config.url}`)

      if (!step.config.url) throw new Error('EXTERNAL_API step is missing required config: url')

      const apiRes = await fetch(step.config.url, {
        method: step.config.method || 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: step.config.body ? step.config.body : undefined
      })
      if (!apiRes.ok) throw new Error(`External API responded ${apiRes.status}`)
      logger.info(`External API call succeeded: ${apiRes.status}`)
      return { status: apiRes.status }
    }

    default:
      throw new Error(`Unknown step type: "${step.type}"`)
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
