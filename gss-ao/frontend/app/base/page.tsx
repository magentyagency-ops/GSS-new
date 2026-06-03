import { Library } from "lucide-react";

export default function BasePage() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <Library className="mb-3 h-10 w-10 text-muted-foreground" />
      <h1 className="text-lg font-semibold">Base de connaissances — SLIDE REP AO</h1>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        118 slides réutilisables, 21 catégories, indexées pour le RAG. Explorateur de la base prévu
        dans une prochaine itération.
      </p>
    </div>
  );
}
