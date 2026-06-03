import { Radar } from "lucide-react";

export default function VeillePage() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <Radar className="mb-3 h-10 w-10 text-muted-foreground" />
      <h1 className="text-lg font-semibold">Veille des appels d'offres</h1>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        Module de veille (Nukema / BOAMP / TED) prévu en V1.5. Non inclus dans cette maquette.
      </p>
    </div>
  );
}
