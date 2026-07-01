# LLM Night Watch

### The self-hosted AI stack that continuously improves itself

![cover](./cover.png)

![status](https://img.shields.io/badge/status-early-orange)
![license](https://img.shields.io/badge/license-MIT-blue)
<img src="https://img.shields.io/twitter/follow/tschillaciML?logo=X&color=%20%23f5f5f5"
      alt="follow on X(Twitter)"></a>

Exists next to your self-hosted LLM, re-checks outputs during low gpu utilization to continuously improve the model.

## Quickstart

```bash
npm i
npm run dev
```

## Architecture

```mermaid
flowchart LR
  workload["Your AI workload"] <--> backend["Backend\nFastAPI"]
  frontend["Frontend\nReact + Vite"] <--> backend
  backend <--> vllm["vLLM server\nOpenAI-compatible API"]
```

## Roadmap

- Idle-GPU verification: run an agentic workflow on spare capacity to verify predictions
- Output-quality detection: auto-flag anomalous outputs
- Workload adapters for open-weight inference systems

## Contact

Running open-weight inference in production? I want to hear what you're running.
[@tschillaciml](https://x.com/tschillaciml)

Leave a star if this is helpful.
