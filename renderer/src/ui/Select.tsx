import { Field } from "@base-ui/react/field";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import "./controls.css";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  label?: string;
  disabled?: boolean;
  compact?: boolean;
}

export function Select({ value, onChange, options, label, disabled, compact }: SelectProps) {
  return (
    <Field.Root className={compact ? "qib-field qib-field-compact" : "qib-field"} disabled={disabled} data-slot="field">
      {label && !compact && (
        <Field.Label className="qib-label">
          {label}{disabled && <span className="qib-disabled-note">（当前不可更改）</span>}
        </Field.Label>
      )}
      <SelectPrimitive.Root
        items={options}
        value={options.some((option) => option.value === value) ? value : null}
        modal={false}
        disabled={disabled}
        onValueChange={(next) => { if (next !== null) onChange(next); }}
      >
        <SelectPrimitive.Trigger className="qib-select-trigger" aria-label={label} data-slot="select-trigger">
          <SelectPrimitive.Value className="qib-select-value" placeholder="—" />
          <SelectPrimitive.Icon className="qib-arrow">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m5 6 3-3 3 3m-6 4 3 3 3-3" />
            </svg>
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Portal>
          <SelectPrimitive.Positioner
            positionMethod="fixed"
            align="start"
            sideOffset={4}
            collisionPadding={8}
            alignItemWithTrigger={false}
            className="qib-popover-layer"
          >
            <SelectPrimitive.Popup className="qib-popover coss-select-popup" data-slot="select-popup" data-esc-layer="">
              <SelectPrimitive.List className="qib-listbox" aria-label={label ?? "选项"}>
                {options.map((option) => (
                  <SelectPrimitive.Item className="qib-option" key={option.value} value={option.value} data-slot="select-item">
                    <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                    <SelectPrimitive.ItemIndicator className="qib-option-check" aria-hidden="true">✓</SelectPrimitive.ItemIndicator>
                  </SelectPrimitive.Item>
                ))}
              </SelectPrimitive.List>
            </SelectPrimitive.Popup>
          </SelectPrimitive.Positioner>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
    </Field.Root>
  );
}

export default Select;
