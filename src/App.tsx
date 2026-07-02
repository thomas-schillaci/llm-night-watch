import { useState } from "react";
import { AppHeader } from "./components/AppHeader";
import { ConfigTab } from "./components/ConfigTab";
import { RequestsTab } from "./components/RequestsTab";

type TabId = "config" | "requests";

export function App() {
  const [activeTab, setActiveTab] = useState<TabId>("config");

  return (
    <main className="min-h-screen bg-background text-foreground">
      <AppHeader activeTab={activeTab} onTabChange={setActiveTab} />
      {activeTab === "config" ? <ConfigTab /> : <RequestsTab />}
    </main>
  );
}
