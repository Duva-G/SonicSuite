import {
  useEffect,
  useId,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  size?: "default" | "wide";
  bodyClassName?: string;
};

export default function FullscreenModal({
  isOpen,
  onClose,
  title,
  children,
  size = "default",
  bodyClassName,
}: Props) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!isOpen || typeof window === "undefined") return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const button = closeButtonRef.current;
    if (button) {
      button.focus({ preventScroll: true });
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || typeof document === "undefined") return;
    const { body } = document;
    const originalOverflow = body.style.overflow;
    body.style.overflow = "hidden";
    return () => {
      body.style.overflow = originalOverflow;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleBackdropPointer = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target === overlayRef.current) {
      onClose();
    }
  };

  return (
    <div
      className="fullscreen-modal"
      role="presentation"
      ref={overlayRef}
      onMouseDown={handleBackdropPointer}
    >
      <div
        className={`fullscreen-modal__content${
          size === "wide" ? " fullscreen-modal__content--wide" : ""
        }`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="fullscreen-modal__header">
          <h2 id={titleId} className="fullscreen-modal__title">
            {title}
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            className="control-button button-ghost"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <div
          className={`fullscreen-modal__body${bodyClassName ? ` ${bodyClassName}` : ""}`}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
