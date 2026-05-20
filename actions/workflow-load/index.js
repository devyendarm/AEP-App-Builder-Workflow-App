/**
 * workflow-load/index.js
 *
 * Loads the current workflow configuration from AIO State.
 * Called by the Admin UI on load, and by the Marketer UI to render the step flow.
 */

const { Core } = require('@adobe/aio-sdk')
const stateLib = require('@adobe/aio-lib-state')

async function main (params) {
  const logger = Core.Logger('workflow-load', { level: params.LOG_LEVEL || 'info' })

  try {
    const state = await stateLib.init()
    const entry = await state.get('workflow_config')

    if (!entry || !entry.value) {
      return {
        statusCode: 200,
        body: { configured: false, message: 'No workflow configuration found. Please configure via the Admin panel.' }
      }
    }

    logger.info(`Workflow config loaded: "${entry.value.workflowName}"`)
    return {
      statusCode: 200,
      body: { configured: true, ...entry.value }
    }

  } catch (error) {
    logger.error(`workflow-load error: ${error.message}`)
    return { statusCode: 500, body: { error: 'Failed to load workflow config.', details: error.message } }
  }
}

exports.main = main
