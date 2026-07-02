import { Github } from "lucide-react";

type TabId = "config" | "requests";

type AppHeaderProps = {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
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

export function AppHeader({ activeTab, onTabChange }: AppHeaderProps) {
  return (
    <header className="border-b bg-background">
      <div className="mx-auto flex w-full max-w-[1600px] items-center justify-between px-5 py-4">
        <h1 className="text-2xl font-semibold tracking-normal">LLM Night Watch</h1>
        <div className="flex items-center gap-3 text-muted-foreground">
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
