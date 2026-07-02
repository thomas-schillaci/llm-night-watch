import { useEffect, useState } from "react";
import { Github } from "lucide-react";

const API_BASE = "";
const STATUS_POLL_INTERVAL_MS = 10_000;

type TabId = "config" | "requests";

type AppHeaderProps = {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
};

type ConnectionState = "checking" | "connected" | "disconnected";

type UpstreamStatus = {
  connected: boolean;
  detail: string;
  error: string;
};

const tabs: Array<{ id: TabId; label: string }> = [
  { id: "config", label: "Config" },
  { id: "requests", label: "Requests" },
];

function XIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function ConnectionIndicator() {
  const [state, setState] = useState<ConnectionState>("checking");
  const [message, setMessage] = useState("Checking connection to the OpenAI endpoint…");

  useEffect(() => {
    let cancelled = false;

    async function checkStatus() {
      try {
        const response = await fetch(`${API_BASE}/api/status`);
        const payload = (await response.json()) as UpstreamStatus;
        if (cancelled) {
          return;
        }
        if (payload.connected) {
          setState("connected");
          setMessage(payload.detail || "Connected to the OpenAI endpoint");
        } else {
          setState("disconnected");
          setMessage(payload.error || "Could not reach the OpenAI endpoint");
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        setState("disconnected");
        setMessage(error instanceof Error ? error.message : "Could not reach the OpenAI endpoint");
      }
    }

    void checkStatus();
    const interval = window.setInterval(() => void checkStatus(), STATUS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const dotClass = state === "connected" ? "bg-emerald-500" : state === "disconnected" ? "bg-destructive" : "bg-muted-foreground";
  const label = state === "connected" ? "Endpoint connected" : state === "disconnected" ? "Endpoint disconnected" : "Checking…";

  return (
    <div className="flex items-center gap-2 text-sm" title={message}>
      <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${dotClass} ${state !== "disconnected" ? "animate-pulse" : ""}`} />
      <span className="hidden sm:inline">{label}</span>
    </div>
  );
}

export function AppHeader({ activeTab, onTabChange }: AppHeaderProps) {
  return (
    <header className="border-b bg-background">
      <div className="mx-auto flex w-full max-w-[1600px] items-center justify-between px-5 py-4">
        <h1 className="text-2xl font-semibold tracking-normal">LLM Night Watch</h1>
        <div className="flex items-center gap-4 text-muted-foreground">
          <ConnectionIndicator />
          <div className="flex items-center gap-3 border-l pl-4">
            <a
              aria-label="GitHub repository"
              href="https://github.com/thomas-schillaci/llm-night-watch"
              rel="noreferrer"
              target="_blank"
              className="hover:text-foreground"
            >
              <Github className="h-5 w-5" />
            </a>
            <a
              aria-label="X profile"
              href="https://x.com/tschillaciML"
              rel="noreferrer"
              target="_blank"
              className="hover:text-foreground"
            >
              <XIcon />
            </a>
          </div>
        </div>
      </div>
      <nav className="mx-auto flex w-full max-w-[1600px] gap-1 px-5" aria-label="Primary">
        {tabs.map((tab) => (
          <button
            className={
              activeTab === tab.id
                ? "border-b-2 border-primary px-3 py-2 text-sm font-medium text-foreground"
                : "border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
            }
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </nav>
    </header>
  );
}
