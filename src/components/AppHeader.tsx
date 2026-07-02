type TabId = "config" | "requests";

type AppHeaderProps = {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
};

const tabs: Array<{ id: TabId; label: string }> = [
  { id: "config", label: "Config" },
  { id: "requests", label: "Requests" },
];

export function AppHeader({ activeTab, onTabChange }: AppHeaderProps) {
  return (
    <header className="border-b bg-background">
      <div className="mx-auto flex w-full max-w-[1600px] px-5 py-4">
        <h1 className="text-2xl font-semibold tracking-normal">LLM Night Watch</h1>
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
