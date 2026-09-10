import {
  Button as AriaButton,
  TextField,
  Input,
  TextArea,
  Label,
  Switch,
  Select,
  SelectValue,
  Popover,
  ListBox,
  ListBoxItem,
  DialogTrigger,
  ModalOverlay,
  Modal,
  Dialog,
  Heading,
  type ButtonProps,
} from 'react-aria-components'
import { ChevronDown, X, LoaderCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import { useJarvis } from './state'

export function Button({
  children,
  variant = 'secondary',
  className = '',
  busy = false,
  ...props
}: ButtonProps & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; busy?: boolean }) {
  return (
    <AriaButton
      {...props}
      isDisabled={props.isDisabled || busy}
      className={`button ${variant} ${className}`}
    >
      {busy && <LoaderCircle size={14} className="spin" />}
      {children as ReactNode}
    </AriaButton>
  )
}
export function IconButton({
  label,
  children,
  ...props
}: ButtonProps & { label: string; children: ReactNode }) {
  return (
    <Button {...props} variant="ghost" className="icon-button" aria-label={label}>
      {children}
    </Button>
  )
}
export function Field({
  label,
  value,
  onChange,
  description,
  placeholder,
  multiline = false,
  type = 'text',
  autoFocus = false,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  description?: string
  placeholder?: string
  multiline?: boolean
  type?: string
  autoFocus?: boolean
}) {
  return (
    <TextField
      className="field"
      value={value}
      onChange={onChange}
      type={type}
      autoFocus={autoFocus}
    >
      <Label>{label}</Label>
      {multiline ? (
        <TextArea className="resize-none" placeholder={placeholder} rows={3} />
      ) : (
        <Input placeholder={placeholder} />
      )}
      {description && <p className="field-help">{description}</p>}
    </TextField>
  )
}
export function Toggle({
  label,
  description,
  selected,
  onChange,
}: {
  label: string
  description?: string
  selected: boolean
  onChange: (selected: boolean) => void
}) {
  return (
    <Switch className="toggle-row" isSelected={selected} onChange={onChange}>
      <span>
        <span className="row-title">{label}</span>
        {description && <span className="row-description">{description}</span>}
      </span>
      <span className="switch-track">
        <span />
      </span>
    </Switch>
  )
}
export function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: { id: string; label: string }[]
  onChange: (key: string) => void
}) {
  return (
    <Select
      className="field choice"
      selectedKey={value}
      onSelectionChange={(key) => onChange(String(key))}
    >
      <Label>{label}</Label>
      <AriaButton className="select-button">
        <SelectValue />
        <ChevronDown size={14} />
      </AriaButton>
      <Popover className="select-popover" placement="bottom start">
        <ListBox items={options}>
          {(item) => (
            <ListBoxItem id={item.id} textValue={item.label}>
              {item.label}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </Select>
  )
}
export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'active' | 'attention' | 'error'
}) {
  return (
    <span className={`badge ${tone}`}>
      <i />
      {children}
    </span>
  )
}
export function Group({
  title,
  detail,
  children,
}: {
  title: string
  detail?: string
  children: ReactNode
}) {
  return (
    <section className="settings-group">
      <div className="group-heading">
        <h2>{title}</h2>
        {detail && <p>{detail}</p>}
      </div>
      <div className="group-content">{children}</div>
    </section>
  )
}
export function Row({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children?: ReactNode
}) {
  return (
    <div className="setting-row">
      <div>
        <span className="row-title">{title}</span>
        {description && <span className="row-description">{description}</span>}
      </div>
      {children}
    </div>
  )
}
export function Empty({
  icon,
  title,
  detail,
  children,
}: {
  icon: ReactNode
  title: string
  detail: string
  children?: ReactNode
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{detail}</p>
      {children}
    </div>
  )
}
export function Confirm({
  trigger,
  title,
  description,
  action,
  destructive = false,
  onConfirm,
}: {
  trigger: ReactNode
  title: string
  description: string
  action: string
  destructive?: boolean
  onConfirm: () => void
}) {
  return (
    <DialogTrigger>
      {trigger}
      <ModalOverlay className="modal-overlay">
        <Modal className="modal">
          <Dialog>
            {({ close }) => (
              <>
                <Heading slot="title">{title}</Heading>
                <p>{description}</p>
                <div className="actions">
                  <Button onPress={close}>Keep it</Button>
                  <Button
                    variant={destructive ? 'danger' : 'primary'}
                    onPress={() => {
                      onConfirm()
                      close()
                    }}
                  >
                    {action}
                  </Button>
                </div>
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </DialogTrigger>
  )
}
export function Notices() {
  const { notice, dismiss } = useJarvis()
  return notice ? (
    <div className={`notice ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
      <span>{notice.message}</span>
      <IconButton label="Dismiss message" onPress={dismiss}>
        <X size={14} />
      </IconButton>
    </div>
  ) : null
}
