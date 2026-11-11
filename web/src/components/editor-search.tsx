import { useEffect, useRef, useState } from "react"
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search"
import type { EditorView } from "@codemirror/view"
import {
  CaseSensitiveIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  RegexIcon,
  WholeWordIcon,
  XIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Toggle } from "@/components/ui/toggle"
import { countMatches, describeCount } from "@/lib/search-count"

interface EditorSearchProps {
  view: EditorView
  /** Changes whenever the editor updates, so the match count follows the text. */
  tick: number
  /** Changes whenever the bar should take focus (Cmd/Ctrl+F). */
  focusSeq: number
}

const TOGGLE = "size-6 min-w-6 px-0"

/** The find and replace bar, laid over the top right of the editor. CodeMirror still does the searching. */
export function EditorSearch({ view, tick, focusSeq }: EditorSearchProps) {
  void tick
  const query = getSearchQuery(view.state)
  const searchInput = useRef<HTMLInputElement>(null)
  const [replaceOpen, setReplaceOpen] = useState(query.replace !== "")

  useEffect(() => {
    searchInput.current?.focus()
    searchInput.current?.select()
  }, [focusSeq])

  function update(change: Partial<ConstructorParameters<typeof SearchQuery>[0]>) {
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          search: query.search,
          replace: query.replace,
          caseSensitive: query.caseSensitive,
          regexp: query.regexp,
          wholeWord: query.wholeWord,
          literal: query.literal,
          ...change,
        })
      ),
    })
    // Follow the typing: select the nearest match.
    if (change.search !== undefined || change.caseSensitive !== undefined || change.regexp !== undefined || change.wholeWord !== undefined) {
      const next = getSearchQuery(view.state)
      if (next.search !== "" && next.valid) findNext(view)
    }
  }

  function close() {
    closeSearchPanel(view)
    view.focus()
  }

  const count = countMatches(view.state, query)
  const message = describeCount(query.search, query.valid, count)
  const invalid = query.search !== "" && !query.valid

  return (
    <div
      role="search"
      aria-label="Find in the Caddyfile"
      className="absolute top-2 right-[calc(var(--side-drawer-width,0px)+1.25rem)] z-20 flex w-[24rem] max-w-[calc(100%-var(--side-drawer-width,0px)-2.5rem)] flex-col gap-1.5 rounded-lg border bg-popover p-1.5 text-popover-foreground shadow-md"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault()
          close()
        } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
          event.preventDefault()
          searchInput.current?.focus()
          searchInput.current?.select()
        }
      }}
    >
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={replaceOpen ? "Hide replace" : "Show replace"}
          aria-expanded={replaceOpen}
          onClick={() => setReplaceOpen((open) => !open)}
        >
          {replaceOpen ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </Button>
        <InputGroup className="h-7 min-w-0 flex-1">
          <InputGroupInput
            ref={searchInput}
            value={query.search}
            placeholder="Find"
            aria-label="Find"
            aria-invalid={invalid}
            autoComplete="off"
            spellCheck={false}
            className="h-7 px-2 text-xs"
            onChange={(event) => {
              update({ search: event.target.value })
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                if (event.shiftKey) findPrevious(view)
                else findNext(view)
              }
            }}
          />
          <InputGroupAddon align="inline-end" className="gap-0.5 pr-1">
            <Toggle
              size="sm"
              className={TOGGLE}
              aria-label="Match case"
              title="Match case"
              pressed={query.caseSensitive}
              onPressedChange={(pressed) => update({ caseSensitive: pressed })}
            >
              <CaseSensitiveIcon />
            </Toggle>
            <Toggle
              size="sm"
              className={TOGGLE}
              aria-label="Whole word"
              title="Whole word"
              pressed={query.wholeWord}
              onPressedChange={(pressed) => update({ wholeWord: pressed })}
            >
              <WholeWordIcon />
            </Toggle>
            <Toggle
              size="sm"
              className={TOGGLE}
              aria-label="Regular expression"
              title="Regular expression"
              pressed={query.regexp}
              onPressedChange={(pressed) => update({ regexp: pressed })}
            >
              <RegexIcon />
            </Toggle>
          </InputGroupAddon>
        </InputGroup>
        <span
          aria-live="polite"
          className={`min-w-14 text-center text-xs whitespace-nowrap ${invalid || (query.search !== "" && count.total === 0) ? "text-destructive" : "text-muted-foreground"}`}
        >
          {message}
        </span>
        <Button variant="ghost" size="icon-xs" aria-label="Previous match" title="Previous match (Shift+Enter)" onClick={() => findPrevious(view)}>
          <ChevronUpIcon />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Next match" title="Next match (Enter)" onClick={() => findNext(view)}>
          <ChevronDownIcon />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Close search" title="Close (Esc)" onClick={close}>
          <XIcon />
        </Button>
      </div>
      {replaceOpen && (
        <div className="flex items-center gap-1 pl-7">
          <InputGroup className="h-7 min-w-0 flex-1">
            <InputGroupInput
              value={query.replace}
              placeholder="Replace"
              aria-label="Replace"
              autoComplete="off"
              spellCheck={false}
              className="h-7 px-2 text-xs"
              onChange={(event) => {
                update({ replace: event.target.value })
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  replaceNext(view)
                }
              }}
            />
          </InputGroup>
          <Button variant="outline" size="sm" onClick={() => replaceNext(view)} disabled={count.total === 0}>
            Replace
          </Button>
          <Button variant="outline" size="sm" onClick={() => replaceAll(view)} disabled={count.total === 0}>
            All
          </Button>
        </div>
      )}
    </div>
  )
}
