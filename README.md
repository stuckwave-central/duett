# DUETT

Eine Mod für Claude Code: Eine zweite, lokal installierte KI prüft nach jeder Runde den Code, den Claude gerade geschrieben hat.

## Was sie macht

- Im ersten Prompt eines neuen Chats öffnet sich das DUETT-Panel mit der Frage, ob ein Prüfer mitlaufen soll.
- DUETT sucht lokal installierte KI-CLIs: **ChatGPT Codex** (Standard), Gemini CLI, Qwen Code oder Ollama. Einer davon wird als Prüfer gewählt.
- Nach jeder Runde, in der Claude Dateien geändert hat (Edit, Write, MultiEdit, NotebookEdit), bekommt der Prüfer den `git diff` dieser Dateien. Ohne Git bekommt er ihren aktuellen Inhalt. Er schreibt dazu ein kurzes Review mit Datei:Zeile, Schweregrad und Vorschlag. Der Prüfer ändert selbst keine Dateien. Codex läuft dafür mit `--sandbox read-only`.
- Mit „Befunde an Claude geben“ landet das Review als Prompt bei Claude. Claude prüft dann jeden Befund und setzt die berechtigten um.
- `/duett` öffnet das Panel jederzeit von Hand.

Der gewählte Prüfer wird gespeichert und gilt auch in späteren Sessions.

## Voraussetzungen

Mindestens eine dieser CLIs muss im `PATH` liegen: `codex`, `gemini`, `qwen` oder `ollama` (mit mindestens einem installierten Modell). Codex installierst du so:

```bash
npm i -g @openai/codex
```

**Hinweis zum Datenschutz:** Die geänderten Dateien gehen an die gewählte CLI. Bei Codex, Gemini und Qwen heißt das: an den jeweiligen Cloud-Anbieter. Nur mit Ollama bleibt alles auf deinem Rechner.

## Installation

Am Prompt einer Claude-Code-Session im Terminal:

```
/plugin install duett --marketplace stuckwave-central/duett
```

Bestätige `Add marketplace?` mit `y` und wähle dann den Scope (user ist voreingestellt).

Aus einer Shell:

```bash
claude plugin install duett --marketplace stuckwave-central/duett
```

In der Claude-Desktop-App, wo `/plugin` nicht läuft: Klicke auf **+** neben dem Eingabefeld, dann auf **Plugins**, dann **Add marketplace** mit `stuckwave-central/duett` und zuletzt **Add plugin**.

## Lizenz

MIT, siehe [LICENSE](LICENSE).
