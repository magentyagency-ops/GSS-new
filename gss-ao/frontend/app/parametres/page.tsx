"use client";

import { ShieldCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";

export default function ParametresPage() {
  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border bg-card px-6 py-4">
        <h1 className="text-xl font-semibold">Paramètres</h1>
        <p className="text-sm text-muted-foreground">
          Configuration générale de l'application GSS-AO.
        </p>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-2xl space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="h-5 w-5 text-success" /> Configuration IA Sécurisée
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                La clé d'authentification OpenAI est déjà configurée au niveau de l'infrastructure de votre serveur et protégée par nos équipes.
                <br /><br />
                Vous n'avez aucune action requise pour utiliser la génération d'intelligence artificielle sur vos dossiers. 
                L'ensemble du système est opérationnel.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
