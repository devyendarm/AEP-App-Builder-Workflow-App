/**
 * workflow-save/index.js
 *
 * Admin action: saves the workflow configuration to AIO State.
 * Called from the Admin UI "Save Configuration" button.
 *
 * Params:
 *   workflowName  {string}  Display name for the workflow
 *   orgId         {string}  Adobe IMS Org ID (e.g. xxx@AdobeOrg)
 *   sandboxName   {string}  AEP sandbox name (e.g. 'prod')
 *   stepsJson     {string}  JSON string of the steps array
 *
 * Saves to AIO State key: 'workflow_config'
 */

const { Core } = require('@adobe/aio-sdk')
const stateLib = require('@adobe/aio-lib-state')

const STEP_TYPES = ['INGEST', 'QUERY', 'DESTINATION_FLOW', 'EXTERNAL_API']

async function main (params) {
  const logger = Core.Logger('workflow-save', { level: params.LOG_LEVEL || 'info' })

  try {
    const { workflowName, orgId, sandboxName, stepsJson } = params

    // --- Validate required fields ---
    if (!orgId) return { statusCode: 400, body: { error: 'orgId is required.' } }
    if (!sandboxName) return { statusCode: 400, body: { error: 'sandboxName is required.' } }
    if (!stepsJson) return { statusCode: 400, body: { error: 'stepsJson is required.' } }

    // --- Parse and validate steps JSON ---
    let steps
    try {
      steps = JSON.parse(stepsJson)
    } catch (e) {
      return { statusCode: 400, body: { error: 'stepsJson is not valid JSON. Please check the format.' } }
    }

    if (!Array.isArray(steps) || steps.length === 0) {
      return { statusCode: 400, body: { error: 'stepsJson must be a non-empty JSON array.' } }
    }

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]
      if (!step.type || !STEP_TYPES.includes(step.type)) {
        return {
          statusCode: 400,
          body: { error: `Step ${i + 1}: invalid type "${step.type}". Must be one of: ${STEP_TYPES.join(', ')}` }
        }
      }
      if (!step.label) step.label = step.type // Default label to type name
      if (!step.config) step.config = {}
    }

    // --- Save to AIO State (TTL: 1 year) ---
    const state = await stateLib.init()
    const config = {
      workflowName: workflowName || 'AEP Campaign Pipeline',
      orgId: orgId.trim(),
      sandboxName: sandboxName.trim(),
      steps,
      updatedAt: new Date().toISOString()
    }

    await state.put('workflow_config', config, { ttl: 31536000 })
    logger.info(`Workflow config saved: "${config.workflowName}" with ${steps.length} step(s)`)

    return {
      statusCode: 200,
      body: {
        message: `Workflow "${config.workflowName}" saved successfully with ${steps.length} step(s).`,
        workflowName: config.workflowName,
        stepCount: steps.length,
        stepTypes: steps.map(s => s.type)
      }
    }

  } catch (error) {
    logger.error(`workflow-save error: ${error.message}`)
    return { statusCode: 500, body: { error: 'Failed to save workflow config.', details: error.message } }
  }
}

exports.main = main
