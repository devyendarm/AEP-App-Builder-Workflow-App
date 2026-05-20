# AEP App Builder Workflow App

A native Adobe App Builder application designed for marketers and administrators to visually construct, execute, and monitor sequential workflows on Adobe Experience Platform (AEP).

---

## ⚡ Key Features

* **Visual Workflow Builder (Admin Panel):** Add, drag, configure, and save sequential steps (`INGEST`, `QUERY`, `DESTINATION_FLOW`, and `EXTERNAL_API`) directly to Adobe AIO State.
* **Marketer Run UI:** Simplified dashboard for upload-and-run campaigns with under-50MB CSV validation, custom naming, and step-by-step progress tracking.
* **Background Orchestrator:** Event-driven sequential processor triggered automatically by AEP `FlowRunSucceeded`/`FlowRunFailed` ingestion webhooks.
* **Automatic Auth Rotation:** Dynamically fetches and caches IMS OAuth Server-to-Server tokens, separating marketer UI access from developer platform credentials.
* **Retry Engine:** Ability to reset and restart failed steps directly from the UI without losing run history or duplicate ingestions.

---

## 🏗️ Architecture

```
                 +--------------------------+
                 |    Marketer/Admin UI     |
                 +--------------------------+
                   /                      \
      Configures / Runs                Polls Status
                 /                          \
                v                            v
      +--------------+                 +------------------+
      | file-router  |                 | workflow-status  |
      +--------------+                 +------------------+
             |                                  |
    Creates AEP Batch                     Checks Query Job
             |                                  |
             v                                  v
+-------------------------+            +------------------+
| Adobe Ingest Service    |            | AEP Query Service|
+-------------------------+            +------------------+
             |                                  ^
     FlowRunSucceeded                           |
             |                                  |
             v                             Triggers Step
      +------------------+                      |
      |event-orchestrator| ---------------------+
      +------------------+
```

---

## 📂 Project Structure

```
├── actions/                  # Serverless OpenWhisk Node.js actions
│   ├── file-router/          # Handles CSV upload & schedules run
│   ├── event-orchestrator/   # Core step advancer (webhook-triggered)
│   ├── workflow-status/      # Active polling status crank for Query jobs
│   ├── workflow-retry/       # Action to resume failed runs
│   ├── workflow-save/        # Saves config to AIO State
│   └── workflow-load/        # Reads config from AIO State
├── src/                      # Marketer & Admin Single Page Application (React)
│   └── App.js                # React Spectrum dynamic GUI
├── app.config.yaml           # Primary App Builder configuration manifest
├── workflow.config.json      # Pipeline configuration file
├── INSTRUCTIONS.md           # Step-by-step installation and console configuration
└── README.md                 # This file
```

---

## 🚀 Setup & Deployment

1. Follow the **[Prerequisites & Pre-Configuration](INSTRUCTIONS.md#phase-0-prerequisites-one-time-laptop-setup)** in `INSTRUCTIONS.md` to set up your Adobe Developer Console Stage Workspace.
2. Initialize the App Builder workspace on your system:
   ```bash
   aio app init
   ```
3. Copy these repository files into your workspace, overwriting the default templates.
4. Set up your **Workspace Secrets** (`AEP_API_KEY` and `AEP_CLIENT_SECRET`) in the Developer Console.
5. Deploy to the cloud:
   ```bash
   aio app deploy
   ```

For detailed troubleshooting, Node 22 workarounds, and step-by-step setup guides, refer to **[INSTRUCTIONS.md](INSTRUCTIONS.md)**.
