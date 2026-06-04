"use client";

import { useEffect, useState } from "react";
import { Key, Eye, EyeOff, CheckCircle2, XCircle, Loader2, ShieldQuestion } from "lucide-react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { getApiKey, setApiKey, testKey } from "@/lib/ai/client";

type Status = "unknown" | "valid" | "invalid" | "empty";

export default function ParametresPage() {
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const [status, setStatus] = useState<Status>("empty");
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const k = getApiKey();
    setKey(k);
    setStatus(k ? "unknown" : "empty");
  }, []);

  function onChange(v: string) {
    setKey(v);
    setApiKey(v);
    setStatus(v ? "unknown" : "empty");
    setError(null);
  }

  async function onTest() {
    setTesting(true);
    setError(null);
    try {
      const ok = await testKey(key);
      setStatus(ok ? "valid" : "invalid");
    } catch (e) {
      setStatus("invalid");
      setError(e instanceof Error ? e.message : "Échec du test");
    } finally {
      setTesting(false);
    }
  }

  const statusBadge = {
    valid: <Badge variant="success">Clé valide</Badge>,
    invalid: <Badge variant="destructive">Clé invalide</Badge>,
    unknown: <Badge variant="warning">Non testée</Badge>,
    empty: <Badge variant="secondary">Non saisie</Badge>,
  }[status];

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border bg-card px-6 py-4">
        <h1 className="text-xl font-semibold">Paramètres</h1>
        <p className="text-sm text-muted-foreground">
          Configuration de la génération IA du mémoire technique.
        </p>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-2xl space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Key className="h-4 w-4 text-primary" /> Clé API OpenAI
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                La rédaction des sections (écran Mémoire technique) utilise OpenAI GPT-4o-mini.
                Votre clé est stockée localement dans ce navigateur (<code>localStorage</code>) et
                envoyée uniquement au backend GSS-AO local. Elle n'est jamais partagée.
              </p>

              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <input
                    type={show ? "text" : "password"}
                    value={key}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder="sk-..."
                    className="h-9 w-full rounded-md border border-input bg-background px-3 pr-9 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <button
                    type="button"
                    onClick={() => setShow(!show)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <Button onClick={onTest} disabled={!key || testing} variant="outline">
                  {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldQuestion className="h-4 w-4" />}
                  Tester la connexion
                </Button>
              </div>

              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Statut :</span>
                {statusBadge}
                {status === "valid" && <CheckCircle2 className="h-4 w-4 text-success" />}
                {status === "invalid" && <XCircle className="h-4 w-4 text-destructive" />}
              </div>

              {error && (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                  {error}
                </div>
              )}

              <div className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
                Le test appelle <code>GET /v1/models</code> via le backend (
                <code>/api/test-key</code>). Assurez-vous que le backend tourne sur le port 8000.
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
