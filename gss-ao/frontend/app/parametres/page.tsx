import { Settings } from "lucide-react";

export default function ParametresPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <Settings className="mb-3 h-10 w-10 text-muted-foreground" />
      <h1 className="text-lg font-semibold">Paramètres</h1>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        Gestion des utilisateurs (Sacha, Mme Vaché, M. Marchani), rôles et charte graphique GSS — à
        venir.
      </p>
    </div>
  );
}
