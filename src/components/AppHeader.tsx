export function AppHeader() {
  return (
    <header className="border-b bg-background">
      <div className="mx-auto flex w-full max-w-[1600px] px-5 py-4">
        <h1 className="text-2xl font-semibold tracking-normal">LLM Night Watch</h1>
      </div>
      <nav className="mx-auto flex w-full max-w-[1600px] gap-1 px-5" aria-label="Primary">
        <button className="border-b-2 border-primary px-3 py-2 text-sm font-medium text-foreground" type="button">
          Config
        </button>
      </nav>
    </header>
  );
}
