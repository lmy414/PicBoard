import { Input as InputPrimitive } from "@base-ui/react/input";
import { Toolbar as ToolbarPrimitive } from "@base-ui/react/toolbar";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { useRender } from "@base-ui/react/use-render";
import { forwardRef, type ComponentProps, type ReactElement, type ReactNode } from "react";

type ButtonVariant = "ghost" | "outline" | "secondary" | "default" | "destructive";
type ButtonSize = "sm" | "md" | "icon-sm" | "icon";

const buttonVariants: Record<ButtonVariant, string> = {
  ghost: "border-transparent text-foreground hover:bg-accent aria-pressed:bg-accent aria-pressed:text-accent-foreground",
  outline: "border-input bg-background text-foreground hover:bg-accent",
  secondary: "border-transparent bg-muted text-foreground hover:bg-accent",
  default: "border-primary bg-primary text-primary-foreground hover:opacity-90",
  destructive: "border-destructive bg-destructive text-white hover:opacity-90",
};

const buttonSizes: Record<ButtonSize, string> = {
  sm: "h-7 px-2",
  md: "h-8 px-3",
  "icon-sm": "size-7 p-0",
  icon: "size-8 p-0",
};

function buttonClass(variant: ButtonVariant, size: ButtonSize, className?: string) {
  return `inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-solid text-xs font-medium disabled:opacity-45 ${buttonVariants[variant]} ${buttonSizes[size]} ${className ?? ""}`;
}

type ButtonProps = useRender.ComponentProps<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "ghost", size = "md", className, type = "button", render, ...props }, ref,
) {
  return useRender({
    defaultTagName: "button",
    ref,
    render,
    props: { "data-slot": "button", ...props, type, className: buttonClass(variant, size, className) },
  });
});

export const Input = forwardRef<HTMLInputElement, ComponentProps<typeof InputPrimitive>>(function Input(props, ref) {
  return <InputPrimitive data-slot="input" {...props} ref={ref} />;
});

export function Toolbar({ className, ...props }: ToolbarPrimitive.Root.Props) {
  return <ToolbarPrimitive.Root data-slot="toolbar" className={`flex items-center ${className ?? ""}`} {...props} />;
}

export const ToolbarButton = forwardRef<HTMLButtonElement, Omit<ToolbarPrimitive.Button.Props, "className"> & {
  className?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
}>(function ToolbarButton({ variant = "ghost", size = "icon", className, ...props }, ref) {
  return <ToolbarPrimitive.Button ref={ref} data-slot="toolbar-button" className={buttonClass(variant, size, className)} {...props} />;
});

export function ToolbarSeparator({ className, ...props }: ToolbarPrimitive.Separator.Props) {
  return <ToolbarPrimitive.Separator className={`h-5 w-px shrink-0 bg-border ${className ?? ""}`} data-slot="toolbar-separator" {...props} />;
}

export const TooltipProvider = TooltipPrimitive.Provider;

export function Tooltip({ children, label, side = "top" }: {
  children: ReactElement;
  label: ReactNode;
  side?: TooltipPrimitive.Positioner.Props["side"];
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger render={children} data-slot="tooltip-trigger" />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side={side} sideOffset={7} collisionPadding={8} className="coss-tooltip-layer">
          <TooltipPrimitive.Popup data-slot="tooltip-popup" className="rounded-md border border-solid border-border bg-popover px-2 py-1 text-xs text-foreground shadow-md">
            {label}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export function SegmentedControl({ className, ...props }: ComponentProps<"div">) {
  return <div role="group" data-slot="segmented-control" className={`flex items-center gap-0.5 rounded-lg bg-muted p-0.5 ${className ?? ""}`} {...props} />;
}

export function SegmentedControlItem({ className, ...props }: ComponentProps<"button">) {
  return (
    <Button
      size="sm"
      data-slot="segmented-control-item"
      className={`text-muted-foreground aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-xs ${className ?? ""}`}
      {...props}
    />
  );
}
