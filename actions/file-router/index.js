/**
 * file-router/index.js
 *
 * Called from React UI when a marketer uploads a file.
 * Reads the workflow configuration from AIO State.
 * If the workflow starts with INGEST, executes the AEP Batch Ingestion flow.
 * If the workflow starts with a non-INGEST step (e.g. QUERY), starts execution immediately.
 * Saves run state and latest run ID to AIO State.
 */

const { Core } = require('@adobe/aio-sdk')
const stateLib = require('@adobe/aio-lib-state')

async function main (params) {
  const logger = Core.Logger('file-router', { level: params.LOG_LEVEL || 'info' })

  try {
    logger.info('File Router triggered.')

    // =========================================================================
    // STEP 1: Load workflow configuration from AIO State
    // =========================================================================
    const state = await stateLib.init()
    const configEntry = await state.get('workflow_config')

    if (!configEntry || !configEntry.value) {
      return {
        statusCode: 400,
        body: { error: 'No workflow configuration found. An Admin must configure the workflow first via the Admin panel.' }
      }
    }

    const workflowConfig = configEntry.value
    const { orgId, sandboxName, steps, workflowName } = workflowConfig

    if (!orgId || !sandboxName) {
      return { statusCode: 400, body: { error: 'Workflow config is missing orgId or sandboxName. Please re-configure via Admin panel.' } }
    }

    // =========================================================================
    // STEP 2: Extract and validate file payload from UI
    // =========================================================================
    const { fileName, fileContent, campaignName, enableS3Logging, s3Bucket } = params
    // Retrieve system access token for AEP API calls (so user doesn't need developer privileges)
    let token = ''
    if (params.AEP_API_KEY && params.AEP_CLIENT_SECRET) {
      try {
        const systemToken = await getSystemAccessToken(params, logger)
        token = `Bearer ${systemToken}`
      } catch (e) {
        logger.error('Failed to resolve system access token: ' + e.message)
      }
    } else {
      logger.warn('AEP_API_KEY or AEP_CLIENT_SECRET is missing — action will run in demo mode.')
    }

    if (!fileName) return { statusCode: 400, body: { error: 'Missing required parameter: fileName' } }
    if (!fileContent) return { statusCode: 400, body: { error: 'Missing required parameter: fileContent (base64)' } }

    const fileBuffer = Buffer.from(fileContent, 'base64')
    logger.info(`File received: ${fileName} (${fileBuffer.length} bytes)`)

    // =========================================================================
    // STEP 3: Optional S3 Audit Logging
    // =========================================================================
    let s3Status = 'S3 Logging Disabled'

    if (enableS3Logging) {
      if (!s3Bucket) return { statusCode: 400, body: { error: 'S3 Bucket name is required when S3 Logging is enabled.' } }
      if (!params.AWS_ACCESS_KEY_ID || !params.AWS_SECRET_ACCESS_KEY) {
        return { statusCode: 400, body: { error: 'AWS credentials not configured in Workspace Secrets.' } }
      }

      const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3')
      const s3 = new S3Client({
        region: params.AWS_REGION || 'us-east-1',
        credentials: { accessKeyId: params.AWS_ACCESS_KEY_ID, secretAccessKey: params.AWS_SECRET_ACCESS_KEY }
      })
      const s3Key = `aep-uploads/${new Date().toISOString().split('T')[0]}/${Date.now()}_${fileName}`
      await s3.send(new PutObjectCommand({ Bucket: s3Bucket, Key: s3Key, Body: fileBuffer, ContentType: 'text/csv' }))
      s3Status = `Uploaded to s3://${s3Bucket}/${s3Key}`
      logger.info(s3Status)
    }

    // =========================================================================
    // STEP 4: Resolve first step and initiate ingestion or direct run
    // =========================================================================
    const ingestStep = steps.find(s => s.type === 'INGEST')
    const datasetId = ingestStep?.config?.datasetId
    const ingestStepIndex = steps.findIndex(s => s.type === 'INGEST')

    const runId = `run_${Date.now()}`
    let batchId = null
    let aepStatus = 'Skipped ingestion — no INGEST step configured or no datasetId.'

    const stepResults = {}
    steps.forEach((_, i) => { stepResults[i] = { status: 'PENDING' } })

    const runState = {
      runId,
      campaignName: campaignName || `Campaign_${new Date().toLocaleDateString()}`,
      fileName,
      batchId: null,
      workflowSnapshot: workflowConfig,
      status: 'IN_PROGRESS',
      currentStepIndex: 0,
      stepResults,
      retryCount: 0,
      error: null,
      failedStepIndex: null,
      startedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString()
    }

    if (ingestStepIndex >= 0 && datasetId) {
      // Workflow starts with ingestion — perform ingestion and wait for event
      logger.info(`Performing AEP Batch Ingestion for dataset: ${datasetId}`)
      const aepHeaders = { 'Authorization': token, 'x-gw-ims-org-id': orgId, 'x-sandbox-name': sandboxName, 'Content-Type': 'application/json' }
      const aepBase = 'https://platform.adobe.io/data/foundation/import'

      // 4a: Create batch
      const batchRes = await fetch(`${aepBase}/batches`, {
        method: 'POST', headers: aepHeaders,
        body: JSON.stringify({ datasetId, inputFormat: { format: 'csv' } })
      })
      if (!batchRes.ok) throw new Error(`AEP Create Batch failed: ${batchRes.status} - ${await batchRes.text()}`)
      batchId = (await batchRes.json()).id
      logger.info(`Batch created: ${batchId}`)

      // 4b: Upload file
      const uploadRes = await fetch(`${aepBase}/batches/${batchId}/datasets/${datasetId}/files/${encodeURIComponent(fileName)}`, {
        method: 'PUT',
        headers: { 'Authorization': token, 'x-gw-ims-org-id': orgId, 'x-sandbox-name': sandboxName, 'Content-Type': 'application/octet-stream' },
        body: fileBuffer
      })
      if (!uploadRes.ok) throw new Error(`AEP File Upload failed: ${uploadRes.status} - ${await uploadRes.text()}`)

      // 4c: Signal complete
      const completeRes = await fetch(`${aepBase}/batches/${batchId}?action=COMPLETE`, { method: 'POST', headers: aepHeaders })
      if (!completeRes.ok) throw new Error(`AEP Batch Complete failed: ${completeRes.status} - ${await completeRes.text()}`)

      aepStatus = `Batch ${batchId} submitted. AEP is processing your file.`
      logger.info(aepStatus)

      // Update state for ingestion monitoring
      runState.batchId = batchId
      runState.status = 'INGESTING'
      runState.currentStepIndex = ingestStepIndex
      runState.stepResults[ingestStepIndex] = { status: 'ACTIVE', startedAt: new Date().toISOString() }

      await state.put(`workflow_run_${runId}`, runState, { ttl: 604800 })
      await state.put(`run_by_dataset_${datasetId}`, { runId }, { ttl: 604800 })
      await state.put('latest_run_id', runId, { ttl: 604800 })
      await syncHistory(state, runId, { status: 'INGESTING', error: null, lastUpdated: new Date().toISOString() }, runState)

    } else {
      // No INGEST step or no datasetId — execute workflow steps starting at step 0 immediately
      logger.info('No INGEST step. Starting workflow execution loop directly.')
      
      await state.put(`workflow_run_${runId}`, runState, { ttl: 604800 })
      await state.put('latest_run_id', runId, { ttl: 604800 })
      
      // Initialize run history
      await syncHistory(state, runId, { status: 'IN_PROGRESS', error: null, lastUpdated: new Date().toISOString() }, runState)

      // Execute sequential steps starting from index 0
      let currentIndex = 0
      const MAX_RETRIES = 3
      while (currentIndex < steps.length) {
        const step = steps[currentIndex]
        logger.info(`Running pipeline step ${currentIndex}: ${step.type} — "${step.label}"`)

        runState.stepResults[currentIndex] = { status: 'ACTIVE', startedAt: new Date().toISOString() }
        runState.currentStepIndex = currentIndex
        runState.status = 'IN_PROGRESS'
        runState.lastUpdated = new Date().toISOString()
        await state.put(`workflow_run_${runId}`, runState, { ttl: 604800 })

        try {
          const executeResult = await executeStep(step, workflowConfig, runId, params, token, logger)

          if (step.type === 'QUERY') {
            runState.stepResults[currentIndex] = {
              status: 'ACTIVE',
              queryId: executeResult.queryId,
              startedAt: runState.stepResults[currentIndex].startedAt
            }
            runState.lastUpdated = new Date().toISOString()
            await state.put(`workflow_run_${runId}`, runState, { ttl: 604800 })
            logger.info(`Step ${currentIndex} (${step.type}) submitted. Query ID: ${executeResult.queryId}.`)
            break
          }

          if (step.type === 'DESTINATION_FLOW') {
            runState.stepResults[currentIndex] = {
              status: 'ACTIVE',
              startedAt: runState.stepResults[currentIndex].startedAt
            }
            runState.lastUpdated = new Date().toISOString()
            await state.put(`workflow_run_${runId}`, runState, { ttl: 604800 })
            logger.info(`Step ${currentIndex} (${step.type}) triggered. Waiting for FlowRunSucceeded event...`)
            break
          }

          // Synchronous step completion
          runState.stepResults[currentIndex] = { status: 'COMPLETE', completedAt: new Date().toISOString() }
          currentIndex++

          if (currentIndex >= steps.length) {
            const completedAt = new Date().toISOString()
            runState.status = 'COMPLETE'
            runState.currentStepIndex = currentIndex
            runState.lastUpdated = completedAt
            await state.put(`workflow_run_${runId}`, runState, { ttl: 604800 })
            await syncHistory(state, runId, { status: 'COMPLETE', error: null, lastUpdated: completedAt }, runState)
          } else {
            runState.stepResults[currentIndex] = { status: 'PENDING' }
            runState.currentStepIndex = currentIndex
            runState.lastUpdated = new Date().toISOString()
            await state.put(`workflow_run_${runId}`, runState, { ttl: 604800 })
          }

        } catch (stepError) {
          logger.error(`Step ${currentIndex} (${step.type}) failed: ${stepError.message}`)
          const retryCount = 1
          const isRetryable = retryCount < MAX_RETRIES
          runState.stepResults[currentIndex] = { status: 'ERROR', error: stepError.message }

          const finalStatus = isRetryable ? 'FAILED_RETRYABLE' : 'FAILED_PERMANENT'
          const updatedTime = new Date().toISOString()
          runState.status = finalStatus
          runState.currentStepIndex = currentIndex
          runState.retryCount = retryCount
          runState.failedStepIndex = currentIndex
          runState.error = stepError.message
          runState.lastUpdated = updatedTime
          await state.put(`workflow_run_${runId}`, runState, { ttl: 604800 })
          await syncHistory(state, runId, { status: finalStatus, error: stepError.message, lastUpdated: updatedTime }, runState)
          break
        }
      }
    }

    return {
      statusCode: 200,
      body: { message: 'File uploaded and run initiated successfully.', runId, batchId, workflowName, s3Status, aepStatus }
    }

  } catch (error) {
    logger.error(`File Router Error: ${error.message}`)
    return { statusCode: 500, body: { error: 'File Router Failed', details: error.message } }
  }
}

// =============================================================================
// Step executor — handles all step types dynamically
// =============================================================================
async function executeStep (step, workflow, runId, params, token, logger) {
  const { orgId, sandboxName } = workflow

  // Use headers. Note that here token is passed from __ow_headers (caller's IMS token)
  const getAepHeaders = (contentType = 'application/json') => ({
    'Authorization': token,
    'x-api-key': params.AEP_API_KEY || '',
    'x-gw-ims-org-id': orgId,
    'x-sandbox-name': sandboxName,
    'Content-Type': contentType
  })

  switch (step.type) {
    case 'INGEST':
      logger.info('INGEST step — handled at start.')
      return { skipped: true }

    case 'QUERY': {
      if (!params.AEP_CLIENT_SECRET || !params.AEP_API_KEY) {
        logger.warn('AEP_CLIENT_SECRET or AEP_API_KEY not set — QUERY step running in demo mode (no real query submitted).')
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
      if (!params.AEP_CLIENT_SECRET || !params.AEP_API_KEY) {
        logger.warn('AEP_CLIENT_SECRET or AEP_API_KEY not configured — DESTINATION_FLOW step skipped in demo mode.')
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
async function syncHistory (state, runId, updates, runState) {
  try {
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
        campaignName: runState.campaignName,
        fileName: runState.fileName,
        workflowName: runState.workflowSnapshot?.workflowName || 'Campaign Workflow',
        status: updates.status,
        error: updates.error || null,
        startedAt: runState.startedAt,
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
