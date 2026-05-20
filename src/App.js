/**
 * App.js — AEP Workflow Automation
 *
 * Place at: web-src/src/components/App.js
 *
 * Views:
 *   Admin  — Configure workflow: org ID, sandbox, steps JSON → saved to AIO State
 *   Marketer — Select workflow → upload CSV (if INGEST step) → run → live stepper
 */

import React, { useState, useEffect, useRef } from 'react'
import {
  Provider, defaultTheme, Button, View, Heading, Text,
  FileTrigger, ProgressBar, Checkbox, TextField, TextArea,
  Form, Flex, Badge, Divider, Well, ActionButton
} from '@adobe/react-spectrum'
import actionWebInvoke from '../utils'

// =============================================================================
// Constants
// =============================================================================
const POLL_INTERVAL_MS = 5000

const STEP_TYPE_META = {
  INGEST:           { icon: '📥', color: '#1473E6', label: 'AEP Batch Ingestion' },
  QUERY:            { icon: '🔍', color: '#7B2FBE', label: 'AEP Query Service' },
  DESTINATION_FLOW: { icon: '📤', color: '#E68000', label: 'AEP Destination Flow' },
  EXTERNAL_API:     { icon: '🔗', color: '#2D9D78', label: 'External API Call' }
}

const STEP_COLORS = {
  PENDING:  { bg: '#F5F5F5', border: '#CCCCCC', text: '#767676', circle: '#CCCCCC', circleText: '#767676' },
  ACTIVE:   { bg: '#FFF5E6', border: '#E68000', text: '#E68000', circle: '#E68000', circleText: '#FFFFFF' },
  COMPLETE: { bg: '#EBF8F2', border: '#2D9D78', text: '#2D9D78', circle: '#2D9D78', circleText: '#FFFFFF' },
  ERROR:    { bg: '#FFF0F0', border: '#E34850', text: '#E34850', circle: '#E34850', circleText: '#FFFFFF' }
}

const STEP_ICONS = { PENDING: '○', ACTIVE: '●', COMPLETE: '✓', ERROR: '✕' }

const STEP_TEMPLATE = JSON.stringify([
  { type: 'INGEST', label: 'Load CSV', config: { datasetId: 'REPLACE_WITH_YOUR_DATASET_ID' } },
  { type: 'QUERY',  label: 'Run Segment Query', config: { templateId: 'REPLACE_WITH_YOUR_QUERY_TEMPLATE_ID', queryName: 'My Segment Query' } }
], null, 2)


// =============================================================================
// WorkflowStepper — renders dynamically from steps + stepResults
// =============================================================================
function WorkflowStepper ({ steps = [], stepResults = {} }) {
  if (!steps.length) return null

  return (
    <div style={{ width: '100%', overflowX: 'auto', paddingBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', minWidth: Math.max(500, steps.length * 130) }}>
        {steps.map((step, idx) => {
          const result = stepResults[idx] || {}
          const statusKey = result.status || 'PENDING'
          const colors = STEP_COLORS[statusKey] || STEP_COLORS.PENDING
          const meta = STEP_TYPE_META[step.type] || { icon: '?', color: '#767676' }
          const isLast = idx === steps.length - 1

          return (
            <React.Fragment key={idx}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1, minWidth: 110 }}>
                {/* Type icon + circle */}
                <div style={{
                  width: 40, height: 40, borderRadius: '50%',
                  backgroundColor: colors.circle, color: colors.circleText,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 18, fontWeight: 700,
                  boxShadow: statusKey === 'ACTIVE' ? `0 0 0 4px ${colors.border}44` : 'none',
                  transition: 'all 0.3s ease'
                }}>
                  {statusKey === 'PENDING' || statusKey === 'ACTIVE' ? meta.icon : STEP_ICONS[statusKey]}
                </div>

                {/* Step label card */}
                <div style={{
                  marginTop: 8, padding: '6px 8px', borderRadius: 6, textAlign: 'center',
                  width: '90%', backgroundColor: colors.bg, border: `1.5px solid ${colors.border}`,
                  transition: 'all 0.3s ease'
                }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: colors.text }}>{step.label}</div>
                  <div style={{ fontSize: 9, color: colors.text, opacity: 0.75, marginTop: 2 }}>{step.type}</div>
                </div>
                <div style={{ fontSize: 10, color: '#999', marginTop: 3 }}>Step {idx + 1}</div>
              </div>

              {/* Connector */}
              {!isLast && (
                <div style={{
                  flex: 'none', width: 20, height: 2, marginTop: 19,
                  backgroundColor: statusKey === 'COMPLETE' ? '#2D9D78' : '#CCCCCC',
                  transition: 'background-color 0.3s ease'
                }} />
              )}
            </React.Fragment>
          )
        })}
      </div>
    </div>
  )
}

// =============================================================================
// Main App
// =============================================================================
function App (props) {
  const [isAdmin, setIsAdmin] = useState(false)

  // Admin state
  const [wfName, setWfName]       = useState('')
  const [wfOrgId, setWfOrgId]     = useState('')
  const [wfSandbox, setWfSandbox] = useState('prod')
  const [wfStepsJson, setWfStepsJson] = useState(STEP_TEMPLATE)
  const [isSaving, setIsSaving]   = useState(false)
  const [saveMsg, setSaveMsg]     = useState('')
  const [saveError, setSaveError] = useState('')

  // Marketer state
  const [workflowConfig, setWorkflowConfig] = useState(null)
  const [configLoading, setConfigLoading]   = useState(true)
  const [selectedFile, setSelectedFile]     = useState(null)
  const [campaignName, setCampaignName]     = useState('')
  const [enableS3, setEnableS3]             = useState(false)
  const [s3Bucket, setS3Bucket]             = useState('')
  const [isUploading, setIsUploading]       = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadStep, setUploadStep]         = useState('')
  const [uploadError, setUploadError]       = useState('')
  const [runId, setRunId]                   = useState(null)
  const [workflowStatus, setWorkflowStatus] = useState(null)
  const [isPolling, setIsPolling]           = useState(false)
  const [isRetrying, setIsRetrying]         = useState(false)

  const pollTimerRef = useRef(null)

  // ---------------------------------------------------------------------------
  // Role detection + load workflow config on mount
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (props.ims?.token) {
      const groups = props.ims.profile?.groups || []
      setIsAdmin(groups.some(g => g.name === 'AEP_Workflow_Admin'))
      loadWorkflowConfig()
      loadLatestStatus()
    }
  }, [props.ims])

  useEffect(() => () => { if (pollTimerRef.current) clearInterval(pollTimerRef.current) }, [])

  const loadWorkflowConfig = async () => {
    if (!props.ims?.token) return
    setConfigLoading(true)
    try {
      const res = await actionWebInvoke('workflow-load', props.ims.token, {})
      if (res?.configured) {
        setWorkflowConfig(res)
        // Pre-populate admin form with current config
        setWfName(res.workflowName || '')
        setWfOrgId(res.orgId || '')
        setWfSandbox(res.sandboxName || 'prod')
        setWfStepsJson(JSON.stringify(res.steps || [], null, 2))
      }
    } catch (e) {
      console.warn('Could not load workflow config:', e.message)
    } finally {
      setConfigLoading(false)
    }
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------
  const startPolling = (rid) => {
    setIsPolling(true)
    pollTimerRef.current = setInterval(async () => {
      try {
        const res = await actionWebInvoke('workflow-status', props.ims.token, { runId: rid })
        if (res?.status) {
          setWorkflowStatus(res)
          const terminal = ['COMPLETE', 'FAILED_INGESTION', 'FAILED_PERMANENT']
          if (terminal.includes(res.status)) {
            clearInterval(pollTimerRef.current)
            setIsPolling(false)
          }
        }
      } catch (e) { console.warn('Poll error:', e.message) }
    }, POLL_INTERVAL_MS)
  }

  const stopPolling = () => { clearInterval(pollTimerRef.current); setIsPolling(false) }

  const loadLatestStatus = async () => {
    if (!props.ims?.token) return
    try {
      const res = await actionWebInvoke('workflow-status', props.ims.token, {})
      if (res) {
        setWorkflowStatus(res)
        if (res.runId) {
          setRunId(res.runId)
          const terminal = ['COMPLETE', 'FAILED_INGESTION', 'FAILED_PERMANENT']
          if (!terminal.includes(res.status) && res.status !== 'IDLE') {
            startPolling(res.runId)
          }
        }
      }
    } catch (e) {
      console.warn('Could not load latest run status:', e.message)
    }
  }

  // ---------------------------------------------------------------------------
  // Admin: Save workflow config
  // ---------------------------------------------------------------------------
  const handleSaveConfig = async () => {
    setSaveError('')
    setSaveMsg('')
    setIsSaving(true)
    try {
      const res = await actionWebInvoke('workflow-save', props.ims.token, {
        workflowName: wfName, orgId: wfOrgId, sandboxName: wfSandbox, stepsJson: wfStepsJson
      })
      if (res.error) { setSaveError(res.error); return }
      setSaveMsg(`✅ ${res.message}`)
      await loadWorkflowConfig() // Refresh loaded config
    } catch (e) {
      setSaveError(`Save failed: ${e.message}`)
    } finally {
      setIsSaving(false)
    }
  }

  // ---------------------------------------------------------------------------
  // Marketer: file handlers
  // ---------------------------------------------------------------------------
  const handleFileSelect = (fileList) => {
    const file = Array.from(fileList)[0]
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.csv')) { setUploadError('Only CSV files are supported.'); return }
    if (file.size > 50 * 1024 * 1024) { setUploadError('File exceeds the 50MB limit.'); return }
    setSelectedFile(file)
    setUploadError('')
  }

  const readFileAsBase64 = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result.split(',')[1])
    reader.onerror = () => reject(new Error('Failed to read file.'))
    reader.readAsDataURL(file)
  })

  const handleUpload = async () => {
    if (!selectedFile) return
    stopPolling(); setRunId(null); setWorkflowStatus(null)
    setIsUploading(true); setUploadError('')
    setUploadProgress(10); setUploadStep('Reading file...')
    try {
      const fileContent = await readFileAsBase64(selectedFile)
      setUploadProgress(40); setUploadStep(enableS3 ? 'Uploading to AEP & S3...' : 'Uploading to AEP...')

      const res = await actionWebInvoke('file-router', props.ims.token, {
        fileName: selectedFile.name, fileContent,
        campaignName: campaignName || `Campaign_${new Date().toLocaleDateString()}`,
        enableS3Logging: enableS3, s3Bucket: s3Bucket || ''
      })
      if (res.error) throw new Error(res.error.details || res.error)

      setUploadProgress(100); setUploadStep('Upload complete — monitoring pipeline...')
      setRunId(res.runId)
      startPolling(res.runId)
    } catch (e) {
      setUploadError(`Upload failed: ${e.message}`)
      setUploadProgress(0); setUploadStep('')
    } finally { setIsUploading(false) }
  }

  const handleManualRun = async () => {
    stopPolling(); setRunId(null); setWorkflowStatus(null)
    setIsUploading(true); setUploadError('')
    setUploadProgress(10); setUploadStep('Initiating pipeline run...')
    try {
      const dummyFileName = `manual_run_${Date.now()}.csv`
      const dummyFileContent = btoa('manual run')
      setUploadProgress(40); setUploadStep('Starting workflow execution...')

      const res = await actionWebInvoke('file-router', props.ims.token, {
        fileName: dummyFileName,
        fileContent: dummyFileContent,
        campaignName: campaignName || `Manual_${new Date().toLocaleDateString()}`,
        enableS3Logging: false, s3Bucket: ''
      })
      if (res.error) throw new Error(res.error.details || res.error)

      setUploadProgress(100); setUploadStep('Run initiated — monitoring progress...')
      setRunId(res.runId)
      startPolling(res.runId)
    } catch (e) {
      setUploadError(`Trigger failed: ${e.message}`)
      setUploadProgress(0); setUploadStep('')
    } finally { setIsUploading(false) }
  }

  const handleRetry = async () => {
    setIsRetrying(true)
    try {
      const res = await actionWebInvoke('workflow-retry', props.ims.token, { runId })
      if (res.error === 'INGESTION_FAILURE_REQUIRES_REUPLOAD') {
        setUploadError(res.message)
      } else if (res.error) {
        setUploadError(res.message || res.error)
      } else {
        setUploadError('')
        setWorkflowStatus(prev => ({ ...prev, status: 'IN_PROGRESS', retryCount: res.retryCount }))
        startPolling(runId)
      }
    } catch (e) { setUploadError(`Retry failed: ${e.message}`) }
    finally { setIsRetrying(false) }
  }

  // ---------------------------------------------------------------------------
  // Derived values
  // ---------------------------------------------------------------------------
  const liveSteps    = workflowStatus?.steps || workflowConfig?.steps || []
  const stepResults  = workflowStatus?.stepResults || {}
  const firstStepIsIngest = liveSteps.length > 0 && liveSteps[0]?.type === 'INGEST'
  const pipelineActive   = isUploading || !!runId || !!workflowStatus
  const isFailed         = workflowStatus?.status?.startsWith('FAILED')
  const isRetryable      = workflowStatus?.status === 'FAILED_RETRYABLE'
  const isIngestionFail  = workflowStatus?.status === 'FAILED_INGESTION'
  const isPermanentFail  = workflowStatus?.status === 'FAILED_PERMANENT'
  const isComplete       = workflowStatus?.status === 'COMPLETE'

  // ---------------------------------------------------------------------------
  // Admin View
  // ---------------------------------------------------------------------------
  const renderAdminView = () => (
    <View padding='size-400' maxWidth='size-6000'>
      <Flex justifyContent='space-between' alignItems='center'>
        <Heading level={1}>Workflow Configuration</Heading>
        <Badge variant='info'>Admin Mode</Badge>
      </Flex>
      <Text>Configure the workflow pipeline. All settings are stored securely in Adobe AIO State.</Text>
      <Divider marginY='size-300' />

      <Form maxWidth='size-4600'>
        <TextField label='Workflow Name' placeholder='e.g. Q3 Campaign Pipeline'
          value={wfName} onChange={setWfName} />
        <TextField label='Adobe IMS Org ID' placeholder='xxxxxxx@AdobeOrg'
          value={wfOrgId} onChange={setWfOrgId} isRequired />
        <TextField label='AEP Sandbox Name' placeholder='prod'
          value={wfSandbox} onChange={setWfSandbox} isRequired />
      </Form>

      {/* Steps JSON editor */}
      <View marginTop='size-300'>
        <Heading level={3}>Workflow Steps (JSON)</Heading>
        <Text>
          Define your pipeline steps as a JSON array. Supported types:{' '}
          <strong>INGEST</strong>, <strong>QUERY</strong>, <strong>DESTINATION_FLOW</strong>, <strong>EXTERNAL_API</strong>.
          Steps execute in the order listed. Use any combination.
        </Text>

        {/* Quick-reference for step types */}
        <Well marginY='size-200'>
          <Flex gap='size-300' wrap>
            {Object.entries(STEP_TYPE_META).map(([type, meta]) => (
              <Flex key={type} alignItems='center' gap='size-75'>
                <span style={{ fontSize: 16 }}>{meta.icon}</span>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: meta.color }}>{type}</div>
                  <div style={{ fontSize: 10, color: '#767676' }}>{meta.label}</div>
                </div>
              </Flex>
            ))}
          </Flex>
        </Well>

        <TextArea
          label='Steps JSON Array'
          value={wfStepsJson}
          onChange={setWfStepsJson}
          width='100%'
          UNSAFE_style={{ fontFamily: 'monospace', minHeight: 240 }}
          description='Edit steps above. See workflow.config.json in app_builder_mvp/ for a full example with all 4 step types.'
        />

        {/* Preview stepper from current JSON */}
        {(() => {
          try {
            const preview = JSON.parse(wfStepsJson)
            if (Array.isArray(preview) && preview.length > 0) {
              return (
                <View marginTop='size-200'>
                  <Text UNSAFE_style={{ fontSize: 11, color: '#767676' }}>Preview:</Text>
                  <WorkflowStepper steps={preview} stepResults={{}} />
                </View>
              )
            }
          } catch (_) { /* invalid JSON — no preview */ }
          return null
        })()}
      </View>

      {/* Save */}
      <Flex gap='size-100' marginTop='size-300' alignItems='center'>
        <Button variant='cta' onPress={handleSaveConfig} isDisabled={isSaving}>
          {isSaving ? 'Saving...' : '💾 Save Workflow Configuration'}
        </Button>
        <Button variant='secondary' onPress={() => setWfStepsJson(STEP_TEMPLATE)}>
          Load Template
        </Button>
      </Flex>

      {saveMsg && (
        <View padding='size-150' borderRadius='medium' marginTop='size-200'
          UNSAFE_style={{ backgroundColor: '#EBF8F2', border: '1px solid #2D9D78' }}>
          <Text UNSAFE_style={{ color: '#2D9D78' }}>{saveMsg}</Text>
        </View>
      )}
      {saveError && (
        <View padding='size-150' borderRadius='medium' marginTop='size-200'
          UNSAFE_style={{ backgroundColor: '#FFF0F0', border: '1px solid #E34850' }}>
          <Text UNSAFE_style={{ color: '#E34850' }}>❌ {saveError}</Text>
        </View>
      )}
    </View>
  )

  // ---------------------------------------------------------------------------
  // Marketer View
  // ---------------------------------------------------------------------------
  const renderMarketerView = () => (
    <View padding='size-400' maxWidth='size-6000'>
      <Heading level={1}>Run Campaign Workflow</Heading>

      {configLoading && <Text>Loading workflow configuration...</Text>}

      {!configLoading && !workflowConfig?.configured && (
        <View padding='size-200' borderRadius='medium' UNSAFE_style={{ backgroundColor: '#FFF8EC', border: '1px solid #E68000' }}>
          <Text UNSAFE_style={{ color: '#E68000' }}>
            ⚠️ No workflow has been configured yet. Please ask your Administrator to configure the pipeline via the Admin panel.
          </Text>
        </View>
      )}

      {!configLoading && workflowConfig?.configured && (
        <>
          {/* Workflow info */}
          <Well marginBottom='size-300'>
            <Flex alignItems='center' gap='size-150'>
              <Badge variant='positive'>Active Workflow</Badge>
              <Text><strong>{workflowConfig.workflowName}</strong> — {liveSteps.length} step(s): {liveSteps.map(s => s.label).join(' → ')}</Text>
            </Flex>
          </Well>

          <Divider marginBottom='size-300' />

          {/* Campaign name */}
          <Form maxWidth='size-3600' marginBottom='size-200'>
            <TextField label='Campaign Name (optional)' placeholder='e.g. June Reactivation Run'
              value={campaignName} onChange={setCampaignName} />
          </Form>

          {/* S3 Logging */}
          <View marginBottom='size-200'>
            <Checkbox isSelected={enableS3} onChange={setEnableS3}>Enable S3 Audit Logging</Checkbox>
            {enableS3 && (
              <Form maxWidth='size-3600' marginTop='size-100'>
                <TextField label='S3 Bucket Name' placeholder='my-audit-bucket'
                  value={s3Bucket} onChange={setS3Bucket} isRequired />
              </Form>
            )}
          </View>

          {/* File upload (only if workflow starts with INGEST) */}
          {firstStepIsIngest ? (
            <Flex gap='size-100' alignItems='center' wrap marginBottom='size-200'>
              <FileTrigger acceptedFileTypes={['text/csv', '.csv']} onSelect={handleFileSelect}>
                <Button variant='secondary' isDisabled={isUploading}>
                  {selectedFile ? `📄 ${selectedFile.name}` : 'Select CSV File'}
                </Button>
              </FileTrigger>
              <Button variant='accent' isDisabled={isUploading || !selectedFile} onPress={handleUpload}>
                {isUploading ? 'Uploading...' : 'Upload & Run Pipeline'}
              </Button>
              {selectedFile && !isUploading && (
                <ActionButton onPress={() => { setSelectedFile(null); setUploadError(''); setRunId(null); setWorkflowStatus(null); stopPolling() }}>
                  Reset
                </ActionButton>
              )}
            </Flex>
          ) : (
            <Flex gap='size-100' alignItems='center' wrap marginBottom='size-200'>
              <Button variant='accent' isDisabled={isUploading} onPress={handleManualRun}>
                {isUploading ? 'Starting...' : '⚡ Trigger Pipeline Run'}
              </Button>
            </Flex>
          )}

          {/* Upload progress */}
          {isUploading && (
            <View marginBottom='size-300'>
              <ProgressBar label={uploadStep} value={uploadProgress} minValue={0} maxValue={100} />
            </View>
          )}

          {/* Error */}
          {uploadError && (
            <View padding='size-200' borderRadius='medium' marginBottom='size-200'
              UNSAFE_style={{ backgroundColor: '#FFF0F0', border: '1px solid #E34850' }}>
              <Text UNSAFE_style={{ color: '#E34850' }}>❌ {uploadError}</Text>
            </View>
          )}

          {/* Pipeline step flow */}
          {pipelineActive && (
            <View marginTop='size-300'>
              <Flex justifyContent='space-between' alignItems='center' marginBottom='size-150'>
                <Heading level={3} margin='size-0'>Pipeline Progress</Heading>
                <Flex gap='size-100' alignItems='center'>
                  {isPolling && <Badge variant='info'>● Live</Badge>}
                  {workflowStatus?.lastUpdated && (
                    <Text UNSAFE_style={{ fontSize: 11, color: '#767676' }}>
                      {new Date(workflowStatus.lastUpdated).toLocaleTimeString()}
                    </Text>
                  )}
                </Flex>
              </Flex>

              {/* Legend */}
              <Flex gap='size-200' marginBottom='size-150' wrap>
                {[['#CCCCCC','Pending'],['#E68000','In Progress'],['#2D9D78','Complete'],['#E34850','Failed']].map(([color, label]) => (
                  <Flex key={label} alignItems='center' gap='size-75'>
                    <div style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: color }} />
                    <Text UNSAFE_style={{ fontSize: 11, color: '#767676' }}>{label}</Text>
                  </Flex>
                ))}
              </Flex>

              <WorkflowStepper steps={liveSteps} stepResults={stepResults} />
            </View>
          )}

          {/* Status detail card */}
          {workflowStatus && (
            <Well marginTop='size-300'>
              <Flex direction='column' gap='size-100'>
                <Heading level={4} margin='size-0'>Run Details</Heading>
                {workflowStatus.campaignName && <Text><strong>Campaign:</strong> {workflowStatus.campaignName}</Text>}
                {workflowStatus.fileName && <Text><strong>File:</strong> {workflowStatus.fileName}</Text>}
                {workflowStatus.batchId && <Text><strong>AEP Batch ID:</strong> {workflowStatus.batchId}</Text>}
                {workflowStatus.retryCount > 0 && <Text><strong>Retries:</strong> {workflowStatus.retryCount} / 3</Text>}

                {isFailed && workflowStatus.error && (
                  <View padding='size-150' borderRadius='medium' UNSAFE_style={{ backgroundColor: '#FFF0F0', border: '1px solid #E34850' }}>
                    <Text UNSAFE_style={{ color: '#E34850' }}><strong>Error:</strong> {workflowStatus.error}</Text>
                  </View>
                )}
                {isRetryable && (
                  <View marginTop='size-100'>
                    <Text marginBottom='size-100'>⚠️ A pipeline step failed. You can retry it automatically.</Text>
                    <Button variant='primary' isDisabled={isRetrying} onPress={handleRetry}>
                      {isRetrying ? 'Retrying...' : '↩ Retry Failed Step'}
                    </Button>
                  </View>
                )}
                {isIngestionFail && (
                  <View padding='size-200' borderRadius='medium' UNSAFE_style={{ backgroundColor: '#FFF8EC', border: '1px solid #E68000' }}>
                    <Heading level={4} margin='size-0' UNSAFE_style={{ color: '#E68000' }}>⚠️ Fix & Re-Upload</Heading>
                    <Text>AEP rejected the batch — likely a CSV format issue. Fix your file and re-upload above.</Text>
                  </View>
                )}
                {isPermanentFail && (
                  <View padding='size-200' borderRadius='medium' UNSAFE_style={{ backgroundColor: '#FFF0F0', border: '1px solid #E34850' }}>
                    <Text UNSAFE_style={{ color: '#E34850' }}>❌ Permanently failed after 3 retries. Contact your administrator with Batch ID: {workflowStatus.batchId}</Text>
                  </View>
                )}
                {isComplete && (
                  <View padding='size-200' borderRadius='medium' UNSAFE_style={{ backgroundColor: '#EBF8F2', border: '1px solid #2D9D78' }}>
                    <Text UNSAFE_style={{ color: '#2D9D78' }}>✅ All pipeline steps completed. Your data is live in AEP.</Text>
                  </View>
                )}
              </Flex>
            </Well>
          )}

          {/* ============================================================ */}
          {/* RUN HISTORY TABLE — last 10 runs, most recent first           */}
          {/* ============================================================ */}
          {workflowStatus?.runHistory?.length > 0 && (
            <View marginTop='size-400'>
              <Heading level={3}>Run History (Last {workflowStatus.runHistory.length})</Heading>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ backgroundColor: '#F5F5F5', textAlign: 'left' }}>
                      {['Date / Time', 'Campaign', 'File', 'Status', 'Error'].map(h => (
                        <th key={h} style={{ padding: '8px 12px', borderBottom: '2px solid #E0E0E0', fontWeight: 700, whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {workflowStatus.runHistory.map((run, i) => {
                      const isOk  = run.status === 'COMPLETE'
                      const isFail = run.status?.startsWith('FAILED')
                      const rowBg = isOk ? '#F0FBF6' : isFail ? '#FFF5F5' : i % 2 === 0 ? '#FFFFFF' : '#FAFAFA'
                      const statusColor = isOk ? '#2D9D78' : isFail ? '#E34850' : '#E68000'
                      return (
                        <tr key={run.runId} style={{ backgroundColor: rowBg, borderBottom: '1px solid #EEEEEE' }}>
                          <td style={{ padding: '8px 12px', whiteSpace: 'nowrap', color: '#505050' }}>
                            {run.startedAt ? new Date(run.startedAt).toLocaleString() : '—'}
                          </td>
                          <td style={{ padding: '8px 12px' }}>{run.campaignName || '—'}</td>
                          <td style={{ padding: '8px 12px', color: '#767676', fontSize: 12 }}>{run.fileName || '—'}</td>
                          <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>
                            <span style={{
                              display: 'inline-block', padding: '2px 8px', borderRadius: 10,
                              backgroundColor: `${statusColor}22`, color: statusColor,
                              fontWeight: 700, fontSize: 11
                            }}>
                              {run.status || 'UNKNOWN'}
                            </span>
                          </td>
                          <td style={{ padding: '8px 12px', color: '#E34850', fontSize: 12, maxWidth: 300 }}>
                            {run.error || '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </View>
          )}
        </>
      )}
    </View>
  )


  return (
    <Provider theme={defaultTheme} colorScheme='light'>
      {isAdmin ? renderAdminView() : renderMarketerView()}
    </Provider>
  )
}

export default App
