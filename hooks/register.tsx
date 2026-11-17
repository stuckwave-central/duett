import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DuettPhase, Review } from '../types'

const PANE = 'duett'
const STORE_REVIEWER = 'reviewer'
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const MAX_FILE_CHARS = 20000
const MAX_PROMPT_CHARS = 120000

const phase = atom({ plugin: 'duett', key: 'phase' } as const, 'off' as DuettPhase)
const reviewer = atom({ plugin: 'duett', key: 'reviewer' } as const, 'codex')
const available = atom({ plugin: 'duett', key: 'available' } as const, [] as string[])
const pending = atom({ plugin: 'duett', key: 'pending' } as const, [] as string[])
const emptyReview: Review = { status: 'idle', text: '', files: [], at: 0 }
const review = atom({ plugin: 'duett', key: 'review' } as const, emptyReview, {
  shape: 'review-1',
})

type Reviewer = {
  id: string
  label: string
  bin: string
  /** argv after the binary; the review prompt always goes in on stdin */
  args: (model: string) => string[]
}

// Lokale KI-CLIs, die als Prüfer in Frage kommen. Codex ist der Standard.
const REVIEWERS: Reviewer[] = [
  {
    id: 'codex',
    label: 'ChatGPT Codex',
    bin: 'codex',
    args: () => ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-'],
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    bin: 'gemini',
    args: () => ['-p', 'Fuehre den Code-Review-Auftrag aus der Eingabe aus.'],
  },
  {
    id: 'qwen',
    label: 'Qwen Code',
    bin: 'qwen',
    args: () => ['-p', 'Fuehre den Code-Review-Auftrag aus der Eingabe aus.'],
  },
  {
    id: 'ollama',
    label: 'Ollama (lokales Modell)',
    bin: 'ollama',
    args: model => ['run', model],
  },
]

const DEFAULT: Reviewer = REVIEWERS[0] as Reviewer
const byId = (id: string): Reviewer => REVIEWERS.find(r => r.id === id) ?? DEFAULT

async function isWindows($: EngineInterface) {
  return (await $.env.get('OS')) === 'Windows_NT'
}

async function run(
  $: EngineInterface,
  argv: string[],
  init?: { stdin?: string; timeoutMs?: number },
) {
  const full = (await isWindows($)) ? ['cmd', '/c', ...argv] : argv
  return $.process.run(full, init)
}

async function detect($: EngineInterface): Promise<string[]> {
  const win = await isWindows($)
  const found: string[] = []
  for (const r of REVIEWERS) {
    try {
      const res = await $.process.run(win ? ['where', r.bin] : ['which', r.bin], {
        timeoutMs: 5000,
      })
      if (res.exitCode === 0 && res.stdout.trim() !== '') found.push(r.id)
    } catch {
      // nicht installiert
    }
  }
  return found
}

async function ollamaModel($: EngineInterface): Promise<string | undefined> {
  const res = await run($, ['ollama', 'list'], { timeoutMs: 10000 })
  const names = res.stdout
    .split(/\r?\n/)
    .slice(1)
    .map(line => line.trim().split(/\s+/)[0])
    .filter((n): n is string => typeof n === "string" && n !== "")
  return names.find(n => /coder|code/i.test(n)) ?? names[0]
}

async function changesFor($: EngineInterface, files: string[]): Promise<string> {
  const parts: string[] = []
  for (const file of files) {
    let diff = ''
    try {
      const res = await $.process.run(['git', 'diff', 'HEAD', '--', file], { timeoutMs: 15000 })
      if (res.exitCode === 0) diff = res.stdout.trim()
    } catch {
      // kein git
    }
    if (diff !== '') {
      parts.push(`### ${file} (git diff)\n\`\`\`diff\n${diff.slice(0, MAX_FILE_CHARS)}\n\`\`\``)
      continue
    }
    try {
      const text = String(await $.fs.read(file))
      parts.push(`### ${file} (aktueller Inhalt)\n\`\`\`\n${text.slice(0, MAX_FILE_CHARS)}\n\`\`\``)
    } catch {
      parts.push(`### ${file}\n(Datei nicht lesbar oder geloescht)`)
    }
  }
  return parts.join('\n\n')
}

function reviewPrompt(changes: string) {
  return [
    'Du bist Code-Reviewer in einem DUETT mit Claude Code. Claude hat gerade die',
    'folgenden Aenderungen geschrieben. Pruefe sie kritisch auf: Bugs, Logikfehler,',
    'Sicherheitsprobleme, fehlende Fehlerbehandlung, Randfaelle und unklare Stellen.',
    'Aendere selbst KEINE Dateien. Antworte auf Deutsch, knapp, als nummerierte Liste',
    'mit Datei:Zeile, Schweregrad (hoch/mittel/niedrig) und konkretem Vorschlag.',
    'Wenn alles in Ordnung ist, schreibe nur: "Keine Befunde."',
    '',
    changes,
  ]
    .join('\n')
    .slice(0, MAX_PROMPT_CHARS)
}

async function runReview($: EngineInterface, files: string[]) {
  const id = await read($, reviewer)
  const r = byId(id)
  await update($, review, () => ({ status: 'running', text: '', files, at: Date.now() }))
  $.ui.status(`DUETT: ${r.label} prüft …`)
  try {
    let model = ''
    if (r.id === 'ollama') {
      model = (await ollamaModel($)) ?? ''
      if (model === '') throw new Error('Kein Ollama-Modell installiert (ollama pull …).')
    }
    const changes = await changesFor($, files)
    const res = await run($, [r.bin, ...r.args(model)], {
      stdin: reviewPrompt(changes),
      timeoutMs: 600000,
    })
    const out = res.stdout.trim() || res.stderr.trim()
    if (res.exitCode !== 0 && res.stdout.trim() === '') {
      throw new Error(`${r.label} endete mit Code ${res.exitCode}: ${out.slice(0, 1500)}`)
    }
    await update($, review, () => ({ status: 'done', text: out, files, at: Date.now() }))
    $.ui.toast(`DUETT: ${r.label} hat ${files.length} Datei(en) geprüft`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await update($, review, () => ({ status: 'error', text: msg, files, at: Date.now() }))
    $.ui.toast(`DUETT: Prüfung fehlgeschlagen`)
  } finally {
    $.ui.status(undefined)
  }
}

async function openPane($: EngineInterface) {
  const opened = await $.ui.open({ id: PANE, title: 'DUETT', focus: true })
  if (!opened.isPlaced) $.ui.log(`DUETT-Panel nicht platziert: ${opened.reason}`)
}

// Neuer Chat erkannt, Frage steht noch aus. In der Desktop-App (SDK) ist
// isInteractive false und beim Start oft noch keine Oberflaeche angebunden,
// daher wird erst beim ersten Prompt gefragt.
let askOnFirstPrompt = false

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'duett',
      description: 'DUETT-Panel öffnen: Prüfer-KI wählen, Review ansehen',
    })
    const saved = await $.store.get(STORE_REVIEWER)
    if (typeof saved === 'string') await update($, reviewer, () => saved)

    // Nur bei einem neuen Chat fragen, nicht bei einem fortgesetzten.
    const isNew = (await $.session.messages()).length === 0
    if (isNew && (await read($, phase)) === 'off') {
      if (e.surface !== null) {
        await update($, phase, () => 'ask')
        await openPane($)
      } else {
        askOnFirstPrompt = true
      }
    }
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    if (askOnFirstPrompt) {
      askOnFirstPrompt = false
      if ((await read($, phase)) === 'off') {
        await update($, phase, () => 'ask')
        await openPane($)
      }
    }
    return result
  })

  on('command.run', { command: 'duett' }, async $ => {
    if ((await read($, phase)) === 'off') await update($, phase, () => 'ask')
    await openPane($)
    return { text: 'DUETT-Panel geöffnet.' }
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && EDIT_TOOLS.has(String(e.tool))) {
      const input = e as unknown as { file_path?: string; notebook_path?: string }
      const file = input.file_path ?? input.notebook_path
      if (file && (await read($, phase)) === 'active') {
        await update($, pending, list => (list.includes(file) ? list : [...list, file]))
      }
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.isAborted) return result
    if ((await read($, phase)) !== 'active') return result
    if ((await read($, review)).status === 'running') return result
    const files = await read($, pending)
    if (files.length === 0) return result
    await update($, pending, () => [])
    void runReview($, files)
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Select, Markdown } = $.ui.resolve(e)
    const p = await read($, phase)
    const current = byId(await read($, reviewer))

    if (p === 'ask' || p === 'off') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>DUETT starten?</Text>
          <Text dimColor>
            Eine zweite, lokale KI prüft nach jeder Runde den Code, den Claude geschrieben hat.
          </Text>
          <Box gap={2}>
            <Button
              key="yes"
              label="Ja, DUETT starten"
              variant="primary"
              hotkey="j"
              onPress={async () => {
                await update($, phase, () => 'pick')
                await update($, available, () => [])
                const found = await detect($)
                await update($, available, () => (found.length > 0 ? found : ['none']))
              }}
            />
            <Button
              key="no"
              label="Nein"
              hotkey="n"
              onPress={async () => {
                await update($, phase, () => 'off')
                await $.ui.close({ id: PANE })
              }}
            />
          </Box>
        </Box>
      )
    }

    if (p === 'pick') {
      const found = await read($, available)
      if (found.length === 0) return <Text dimColor>Suche lokale KIs …</Text>
      if (found[0] === 'none' || found[0] === undefined) {
        return (
          <Box flexDirection="column" gap={1}>
            <Text>Keine lokale KI gefunden (codex, gemini, qwen, ollama).</Text>
            <Text dimColor>Codex installieren: npm i -g @openai/codex — danach /duett.</Text>
            <Button key="close" label="Schließen" onPress={() => $.ui.close({ id: PANE })} />
          </Box>
        )
      }
      const options = found.map(id => ({ value: id, label: byId(id).label }))
      const preselect: string = found.includes(current.id) ? current.id : (found[0] ?? 'codex')
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Wer prüft Claudes Code?</Text>
          <Select
            key="reviewer"
            label="Prüfer: "
            options={options}
            value={preselect}
            autoFocus
            onSelect={value => update($, reviewer, () => value)}
          />
          <Button
            key="start"
            label="DUETT starten"
            variant="primary"
            onPress={async () => {
              const chosen = (await read($, available)).includes(await read($, reviewer))
                ? await read($, reviewer)
                : preselect
              await update($, reviewer, () => chosen)
              await $.store.set(STORE_REVIEWER, chosen)
              await update($, phase, () => 'active')
              $.ui.toast(`DUETT aktiv: ${byId(chosen).label} prüft mit`)
            }}
          />
        </Box>
      )
    }

    // active
    const rv = await read($, review)
    const waiting = await read($, pending)
    return (
      <Box flexDirection="column" gap={1}>
        <Text>
          <Text bold>DUETT aktiv</Text> · Prüfer: {current.label}
        </Text>
        {rv.status === 'idle' && (
          <Text dimColor>Warte auf Code-Änderungen von Claude …</Text>
        )}
        {rv.status === 'running' && (
          <Text>{current.label} prüft {rv.files.length} Datei(en) …</Text>
        )}
        {rv.status === 'error' && <Text color="error">Fehler: {rv.text}</Text>}
        {rv.status === 'done' && (
          <Box flexDirection="column">
            <Text dimColor>Geprüft: {rv.files.join(', ')}</Text>
            <Markdown text={rv.text} />
          </Box>
        )}
        {waiting.length > 0 && <Text dimColor>Wartend: {waiting.length} Datei(en)</Text>}
        <Box gap={2}>
          {rv.status === 'done' && rv.text !== 'Keine Befunde.' && (
            <Button
              key="apply"
              label="Befunde an Claude geben"
              variant="primary"
              onPress={() =>
                $.prompt.submit({
                  text: `Code-Review von ${current.label} (DUETT). Prüfe jeden Befund selbst und setze die berechtigten um; begründe kurz, welche du verwirfst:\n\n${rv.text}`,
                })
              }
            />
          )}
          {rv.status !== 'running' && rv.files.length > 0 && (
            <Button key="again" label="Erneut prüfen" onPress={() => void runReview($, rv.files)} />
          )}
          <Button
            key="switch"
            label="Prüfer wechseln"
            onPress={async () => {
              await update($, phase, () => 'pick')
              await update($, available, () => [])
              const found = await detect($)
              await update($, available, () => (found.length > 0 ? found : ['none']))
            }}
          />
          <Button
            key="stop"
            label="DUETT beenden"
            onPress={async () => {
              await update($, phase, () => 'off')
              await update($, pending, () => [])
              await $.ui.close({ id: PANE })
            }}
          />
        </Box>
      </Box>
    )
  })
}
