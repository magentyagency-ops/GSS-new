"""Wrapper OpenAI pour la génération de sections (Module C).

La clé API est fournie par requête (BYO-key, saisie par l'utilisateur dans
l'écran Paramètres). Aucune clé n'est stockée côté serveur.
"""

from __future__ import annotations

from dataclasses import dataclass

from openai import (
    APIConnectionError,
    APIStatusError,
    AuthenticationError,
    OpenAI,
    RateLimitError,
)

DEFAULT_MODEL = "gpt-4o-mini"


class AIError(Exception):
    """Erreur applicative de génération (message destiné au frontend)."""

    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


@dataclass
class Completion:
    text: str
    model: str
    tokens_used: int


def _client(api_key: str) -> OpenAI:
    if not api_key or not api_key.strip():
        raise AIError("Clé API OpenAI manquante.", status_code=400)
    return OpenAI(api_key=api_key.strip())


def chat(
    api_key: str,
    system: str,
    user: str,
    *,
    model: str = DEFAULT_MODEL,
    max_tokens: int = 800,
    temperature: float = 0.4,
    json_mode: bool = False,
) -> Completion:
    """Appel chat completions avec gestion d'erreurs homogène.

    Raises:
        AIError: clé invalide, quota, connexion, ou erreur API — message lisible.
    """
    client = _client(api_key)
    kwargs: dict = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    if json_mode:
        kwargs["response_format"] = {"type": "json_object"}

    try:
        resp = client.chat.completions.create(**kwargs)
    except AuthenticationError as exc:
        raise AIError("Clé API OpenAI invalide ou révoquée.", status_code=401) from exc
    except RateLimitError as exc:
        raise AIError("Quota ou limite de débit OpenAI atteint.", status_code=429) from exc
    except APIConnectionError as exc:
        raise AIError("Connexion à OpenAI impossible.", status_code=503) from exc
    except APIStatusError as exc:
        raise AIError(f"Erreur OpenAI ({exc.status_code}).", status_code=502) from exc

    text = (resp.choices[0].message.content or "").strip()
    tokens = resp.usage.total_tokens if resp.usage else 0
    return Completion(text=text, model=resp.model, tokens_used=tokens)


def test_api_key(api_key: str) -> bool:
    """Valide une clé via un appel léger GET /v1/models."""
    client = _client(api_key)
    try:
        client.models.list()
        return True
    except AuthenticationError:
        return False
    except Exception as exc:  # noqa: BLE001
        raise AIError("Impossible de vérifier la clé (réseau/API).", status_code=502) from exc
