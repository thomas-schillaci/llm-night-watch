# LLM Night Watch

Vite React frontend plus FastAPI backend for document extraction review.

## Run

```bash
pip install -r requirements.txt
npm install
npm run dev
```

Copy `backend/.env.template` to `backend/.env`, then configure the OpenAI-compatible backend:

- `OPENAI_BASE_URL=...`
- `OPENAI_API_KEY=...`
- `OPENAI_MODEL=...`

`backend/.env` is intentionally ignored by git.

## Flow

The browser uploads the PDF only to `/api/extract`. The backend renders page 1 at the requested DPI, converts it to black-and-white JPEG quality 80, base64-encodes it, and calls the OpenAI-compatible chat completions endpoint with the prompt and response format supplied by the frontend. The request uses temperature `0` and max tokens `512`.

The frontend sends a 100 DPI request first. Once it returns, it automatically sends a 200 DPI request and switches the review view to that result.
