export function ComingSoonPage({
  title,
  phase,
  description,
}: {
  title: string;
  phase: number;
  description: string;
}) {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-slate-600">{description}</p>
      </header>
      <div className="rounded-xl border border-dashed border-slate-300 bg-white px-5 py-10 text-center text-sm text-slate-500">
        Arrives in Phase {phase}.
      </div>
    </div>
  );
}

export function NotFoundPage() {
  return (
    <div className="py-16 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="mt-2 text-sm text-slate-600">That page does not exist.</p>
    </div>
  );
}
