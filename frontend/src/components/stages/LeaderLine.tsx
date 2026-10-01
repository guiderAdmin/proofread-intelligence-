import React, { useLayoutEffect, useRef, useState } from "react";

interface LeaderLineProps {
  rootRef: React.RefObject<HTMLDivElement>;
  fromElement: HTMLElement | null;
  toElement: HTMLElement | null;
  color?: string;
}

export default function LeaderLine({ rootRef, fromElement, toElement, color = "#c93428" }: LeaderLineProps) {
  const [isVisible, setIsVisible] = useState(false);
  
  // Refs for direct DOM manipulation to achieve 60fps scrolling
  const svgRef = useRef<SVGSVGElement>(null);
  const pathBgRef = useRef<SVGPathElement>(null);
  const pathMainRef = useRef<SVGPathElement>(null);
  const circleStartRef = useRef<SVGCircleElement>(null);
  const circleEndRef = useRef<SVGCircleElement>(null);

  useLayoutEffect(() => {
    const root = rootRef?.current;
    if (!root || !fromElement || !toElement) {
      setIsVisible(false);
      return undefined;
    }

    let rafId: number;

    const draw = () => {
      const r = root.getBoundingClientRect();
      const a = fromElement.getBoundingClientRect();
      const b = toElement.getBoundingClientRect();

      // Ensure elements are actually visible before drawing
      if (a.width === 0 || b.width === 0) {
        setIsVisible(false);
        return;
      }

      setIsVisible(true);

      // 'from' is the PDF highlight, 'to' is the sidebar card
      const x1 = a.right - r.left; // Right side of PDF highlight
      const y1 = a.top + a.height / 2 - r.top;
      
      const x2 = b.left - r.left; // Left side of sidebar card
      const y2 = b.top + 24 - r.top; // Pointing near the top of the card
      
      const mid = (x1 + x2) / 2;
      const d = `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;

      // Update DOM directly for perfect 60fps sync with scroll
      if (svgRef.current) {
        svgRef.current.setAttribute("width", r.width.toString());
        svgRef.current.setAttribute("height", r.height.toString());
      }
      if (pathBgRef.current) pathBgRef.current.setAttribute("d", d);
      if (pathMainRef.current) pathMainRef.current.setAttribute("d", d);
      if (circleStartRef.current) {
        circleStartRef.current.setAttribute("cx", x1.toString());
        circleStartRef.current.setAttribute("cy", y1.toString());
      }
      if (circleEndRef.current) {
        circleEndRef.current.setAttribute("cx", x2.toString());
        circleEndRef.current.setAttribute("cy", y2.toString());
      }
    };

    const scheduleDraw = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(draw);
    };

    scheduleDraw();
    
    const ro = new ResizeObserver(scheduleDraw);
    ro.observe(root);
    window.addEventListener("scroll", scheduleDraw, true);
    window.addEventListener("resize", scheduleDraw);
    
    // Polling fallback just in case PDF layer shifts without firing scroll/resize
    const t = setInterval(scheduleDraw, 100);

    return () => {
      clearInterval(t);
      cancelAnimationFrame(rafId);
      ro.disconnect();
      window.removeEventListener("scroll", scheduleDraw, true);
      window.removeEventListener("resize", scheduleDraw);
    };
  }, [rootRef, fromElement, toElement]);

  if (!fromElement || !toElement) return null;
  
  return (
    <svg
      ref={svgRef}
      className={`pointer-events-none absolute inset-0 z-50 transition-opacity duration-200 ${isVisible ? "opacity-100" : "opacity-0"}`}
      style={{ overflow: "visible" }}
    >
      {/* Background shadow/glow */}
      <path
        ref={pathBgRef}
        fill="none"
        stroke={color}
        strokeWidth="4"
        strokeLinecap="round"
        className="opacity-15"
      />
      {/* Main crisp dotted line */}
      <path
        ref={pathMainRef}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray="4 6"
        className="opacity-90 drop-shadow-sm"
      />
      {/* Connection dots */}
      <circle ref={circleStartRef} r="3" fill="#fff" stroke={color} strokeWidth="1.5" className="shadow-sm" />
      <circle ref={circleEndRef} r="3" fill="#fff" stroke={color} strokeWidth="1.5" className="shadow-sm" />
    </svg>
  );
}
