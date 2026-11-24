# DICE backend (Person B): AWS cloud swarm, Bedrock synthesis and gatekeeper

A FastAPI WebSocket backend for the Tauri HUD. The wire contract is in [`../SOURCE_OF_TRUTH.md`](../SOURCE_OF_TRUTH.md) §3, mirrored by [`schemas.py`](schemas.py) and [`../hud/src/types.ts`](../hud/src/types.ts).

| Module | Role |
|---|---|
| `main.py` | `GET /health`, `WS /ws/{session_id}`: DISPATCH / STEER (barge-in cancellation by generation + domain) / APPROVAL_DECISION |
| `swarm.py` | Target discovery (DuckDuckGo HTML + Reddit), Tier-1 httpx/BS4 fetch, Tier-2 warm Playwright pool, SSRF guards on every hop, bot-wall detection |
| `gatekeeper.py` | HTML/hidden-text sanitizer, `UNTRUSTED_WEB` taint, Cedar-style policies, per-session approval gates |
| `synthesis.py` | Two-stage Bedrock Converse (router + reasoning model), prompt-injection quarantine, mock mode |
| `test_ws.py` | 23 offline end-to-end cases (mocked fetch and Bedrock) |

## Setting up on a new device

### 1. Prerequisites
- Python **3.11** (3.12 also works; avoid bleeding-edge versions without wheels for pydantic-core/playwright)
- Git access to this repo, on branch `feat/backend-person-b`

```bash
cd backend
python3.11 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m playwright install chromium      # Tier-2 warm browser pool (~150 MB)
```

### 2. Offline check (no AWS needed)
```bash
.venv/bin/python test_ws.py          # expect 23/23 PASS, exit 0
```

### 3. AWS Bedrock (Mumbai, closest region to India)
1. AWS console → **Bedrock** → region **Asia Pacific (Mumbai) `ap-south-1`** → **Model access**: request **Amazon Nova Lite** and **Anthropic Claude Sonnet** (Claude may ask for a short use-case form).
2. Credentials, either:
   - `aws login --region ap-south-1` (browser login, no long-lived keys), or
   - `aws configure` with an IAM user/role allowed only `bedrock:InvokeModel`, `bedrock:Converse`, `bedrock:ListInferenceProfiles`.

   boto3 reads `~/.aws` automatically. **Never put keys in `.env` or commit them.**
3. Find the exact inference-profile IDs available to you:
   ```bash
   aws bedrock list-inference-profiles --region ap-south-1 \
     --query 'inferenceProfileSummaries[].inferenceProfileId' --output text | tr '\t' '\n' | grep -iE 'nova|claude'
   ```
4. Create `backend/.env` (gitignored):
   ```env
   AWS_REGION=ap-south-1
   BEDROCK_ROUTER_MODEL_ID=apac.amazon.nova-lite-v1:0
   BEDROCK_REASONING_MODEL_ID=<newest apac.anthropic.claude-*sonnet* profile from step 3>
   MOCK_BEDROCK=false
   MOCK_FETCH=false
   PLAYWRIGHT_POOL_SIZE=2
   ENABLE_PLAYWRIGHT=true
   ```

### 4. Live Bedrock smoke test
```bash
.venv/bin/python - <<'PY'
import asyncio, os
from dotenv import load_dotenv; load_dotenv(".env")
import gatekeeper, synthesis
chunks = [gatekeeper.TaintedPayload("https://example.com/a", "Model A specs",
          "Model A headphones: 30 hours of playback, adaptive ANC, price 22,990 INR.")]
u = asyncio.run(synthesis.synthesize("smoke", "compare ANC headphones", [], chunks, [], mock_bedrock=False))
print(u.voice_brief); print(len(u.items), "items,", len(u.evidence_cards), "cards")
PY
```
A specific `voice_brief` means real Bedrock worked. A generic brief built straight from the chunk text means it fell back to mock synthesis: check the model IDs, model access, and `aws sts get-caller-identity`.

### 5. Run the server
```bash
.venv/bin/python -m uvicorn main:app --port 8000
curl -s localhost:8000/health        # warm_pool.available should be true once Chromium is installed
```
Point the HUD at `ws://localhost:8000/ws/demo1` (`hud/.env` → `VITE_WS_URL`).

## Environment flags
| Var | Default | Meaning |
|---|---|---|
| `MOCK_BEDROCK` | false | Deterministic synthesis from the fetched text, no AWS calls |
| `MOCK_FETCH` | false | Serve built-in `https://fixtures.mock/...` pages, no network |
| `ENABLE_PLAYWRIGHT` | true | Start the warm Chromium pool (degrades gracefully when missing) |
| `PLAYWRIGHT_POOL_SIZE` | 2 | Warm browser contexts |

## Known limits
- DuckDuckGo/Reddit often bot-wall automated requests. The backend detects this and reports "no reachable sources" rather than treating captcha pages as evidence. For reliable real-web results, pass a `context_url` or add a search API later.
- Approved gated actions are **simulated** (telemetry `COMPLETED … simulated; not executed`). The MVP never submits forms.
- Production needs a TLS-terminated host (EC2/App Runner/ECS) for `wss://`.
