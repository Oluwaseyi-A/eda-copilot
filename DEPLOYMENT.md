# Deployment

This project has two deployable surfaces:

- Static frontend: `index.html`, hosted on Vercel, Firebase Hosting, GitHub Pages, or any static host.
- API service: `src/cloud-api.ts`, deployed as a Cloud Run container with Yosys installed.

## Architecture Boundary

The deployed browser app is not the MCP host and should not spawn MCP servers. Public users send prompts to the backend API. The backend acts as the controlled planner/job host:

```text
Browser -> Cloud Run API -> allowlisted planner -> job executor -> Yosys/artifacts
```

The local MCP server remains for trusted desktop clients such as Cursor, Claude Desktop, Codex, or other MCP hosts. A hosted MCP-compatible interface should only be added later with authentication, authorization, quotas, and sandboxing.

## Build The API Container

```bash
docker build -t eda-copilot-api .
docker run --rm -p 8080:8080 eda-copilot-api
```

Check health:

```bash
curl http://localhost:8080/api/health
```

## Deploy API To Cloud Run

Set these values first:

```bash
export PROJECT_ID="your-gcp-project"
export REGION="us-central1"
export SERVICE="eda-copilot-api"
```

Build and deploy:

```bash
gcloud builds submit --tag "gcr.io/$PROJECT_ID/$SERVICE"
gcloud run deploy "$SERVICE" \
  --image "gcr.io/$PROJECT_ID/$SERVICE" \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --memory 1Gi \
  --cpu 1 \
  --timeout 60
```

After deploy, copy the Cloud Run service URL.

## Configure The Static Frontend

Copy `config.example.js` to `config.js` on the static host and set:

```js
window.EDA_COPILOT_API_URL = "https://YOUR-CLOUD-RUN-URL";
```

Then make sure the static page loads `config.js` before the app script. If `config.js` is missing, the app defaults to `http://localhost:8080` for local development.

## First Hosted MVP

The hosted service runs without an OpenAI key in `rule_based` mode. Add an OpenAI key when you want backend LLM orchestration:

```bash
printf '%s' 'YOUR_OPENAI_API_KEY' | gcloud secrets create openai-api-key \
  --data-file=- \
  --project eda-copilot

gcloud run services update eda-copilot-api \
  --region us-east1 \
  --set-secrets OPENAI_API_KEY=openai-api-key:latest \
  --set-env-vars OPENAI_PLANNER_MODEL=gpt-4o-mini \
  --project eda-copilot
```

Do not put the OpenAI key in the browser or `config.js`.

The deployed app proves this loop:

```text
prompt -> planner decision -> real Yosys synthesis -> artifacts -> browser viewer
```

When `OPENAI_API_KEY` is configured, the planner decision and synthesis summary are produced by the backend OpenAI planner with rule-based fallback.
