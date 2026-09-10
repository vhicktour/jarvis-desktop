import { useState } from 'react'
import {
  BrainCircuit,
  Check,
  LockKeyhole,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import type { MemoryRecord } from '../../../shared/contracts'
import { useJarvis } from '../state'
import { Button, Choice, Confirm, Empty, Field, IconButton } from '../ui'

export function Memory() {
  const { snapshot, command } = useJarvis()
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<MemoryRecord | 'new'>()
  const [text, setText] = useState('')
  const [scope, setScope] = useState('personal')
  const records = snapshot.memories.filter(
    (m) => m.scope === scope && m.text.toLowerCase().includes(query.toLowerCase()),
  )
  return (
    <>
      <div className="section-toolbar">
        <Choice
          label="Memory scope"
          value={scope}
          onChange={setScope}
          options={[
            { id: 'personal', label: 'Personal' },
            ...snapshot.projects.map((p) => ({ id: p.id, label: p.name })),
          ]}
        />
        <Button
          variant="primary"
          onPress={() => {
            setEditing('new')
            setText('')
          }}
        >
          <Plus size={14} />
          Remember something
        </Button>
      </div>
      <div className="search-field">
        <Search size={15} />
        <input
          aria-label="Search memories"
          placeholder="Find a remembered thought…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <IconButton label="Clear memory search" onPress={() => setQuery('')}>
            <X size={13} />
          </IconButton>
        )}
      </div>
      {editing && (
        <div className="editor-card">
          <Field
            label={editing === 'new' ? 'Something useful to remember' : 'Correct this memory'}
            value={text}
            onChange={setText}
            multiline
            placeholder="I prefer…"
            autoFocus
          />
          <div className="actions">
            <Button variant="ghost" onPress={() => setEditing(undefined)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              isDisabled={!text.trim()}
              onPress={async () => {
                const result = await command({
                  type: 'memory.save',
                  id: editing === 'new' ? undefined : editing.id,
                  text,
                  scope,
                  category: 'semantic',
                })
                if (result !== undefined) setEditing(undefined)
              }}
            >
              Save memory
              <Check size={14} />
            </Button>
          </div>
        </div>
      )}
      {records.length ? (
        <div className="memory-list">
          {records.map((memory) => (
            <article className="memory-row" key={memory.id}>
              <div className="memory-marker">
                <BrainCircuit size={16} />
              </div>
              <div>
                <p>{memory.text}</p>
                <span className="metadata">
                  {memory.source} ·{' '}
                  {new Date(memory.updatedAt).toLocaleDateString([], {
                    month: 'short',
                    day: 'numeric',
                  })}
                </span>
                {memory.reviewState === 'proposed' && (
                  <Button
                    onPress={() => {
                      void command({ type: 'memory.approve', id: memory.id })
                    }}
                  >
                    Accept suggested memory
                  </Button>
                )}
              </div>
              <IconButton
                label="Correct memory"
                onPress={() => {
                  setEditing(memory)
                  setText(memory.text)
                }}
              >
                <MoreHorizontal size={16} />
              </IconButton>
              <Confirm
                trigger={
                  <IconButton label="Forget memory">
                    <Trash2 size={14} />
                  </IconButton>
                }
                title="Forget this memory?"
                description="Its derived records and retrieval entries will be removed too."
                action="Forget"
                destructive
                onConfirm={() => {
                  void command({ type: 'memory.delete', id: memory.id })
                }}
              />
            </article>
          ))}
        </div>
      ) : (
        <Empty
          icon={<BrainCircuit size={26} />}
          title={query ? 'Nothing matches just yet.' : 'Useful things, kept close.'}
          detail={
            query
              ? 'Try a different word or choose another scope.'
              : 'Tell Jarvis what matters to you. Every memory has a source, and you can correct or forget it.'
          }
        />
      )}
      <div className="inline-note">
        <LockKeyhole size={15} />
        <p>
          Memories are encrypted on this Mac. Inferred memories need your review before they enter
          recall.
        </p>
      </div>
    </>
  )
}
