import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

type Props = {
  children: ReactNode;
  className?: string;
  fallback?: ReactNode;
  rootMargin?: string;
  threshold?: number;
  triggerOnce?: boolean;
};

export default function InView({
  children,
  className,
  fallback = null,
  rootMargin = "0px",
  threshold = 0.1,
  triggerOnce = true,
}: Props) {
  const targetRef = useRef<HTMLDivElement | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const node = targetRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (entry?.isIntersecting) {
          setIsVisible(true);
          if (triggerOnce) {
            observer.disconnect();
          }
        } else if (!triggerOnce) {
          setIsVisible(false);
        }
      },
      { rootMargin, threshold }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [rootMargin, threshold, triggerOnce]);

  return (
    <div ref={targetRef} className={className}>
      {isVisible ? children : fallback}
    </div>
  );
}

