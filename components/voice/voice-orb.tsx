"use client";

import { useEffect, useRef, useState } from "react";
import type { VoiceSession, VoiceStatus } from "./voice-session";

/** How long a press has to last to end the conversation rather than interrupt it. */
const HOLD_MS = 800;
const SIZE = 232;
const BANDS = 36;

const LABEL: Record<VoiceStatus, string> = {
  idle: "",
  connecting: "Connecting…",
  listening: "Listening — go ahead",
  thinking: "Checking…",
  speaking: "Speaking",
  ended: "",
  error: "",
};

/**
 * The whole voice interface: one circle. While the patient talks, bars and a swell follow
 * their microphone. While the assistant is working something out, it becomes a bubble that
 * floats and turns. While it speaks, the circle is still. The written label underneath
 * always says which, so nothing rests on motion or colour. Talking over the agent stops it, and so does a tap; holding for
 * HOLD_MS ends the conversation, with a ring that fills while you hold so the difference
 * is visible before it happens. Space or Enter does the same from the keyboard.
 */
export default function VoiceOrb({
  session,
  status,
  awaitingYes,
  onInterrupt,
  onEnd,
}: {
  session: VoiceSession | null;
  status: VoiceStatus;
  awaitingYes: boolean;
  onInterrupt: () => void;
  onEnd: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const statusRef = useRef(status);
  const [holding, setHolding] = useState(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ended = useRef(false);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;

    const dpr = window.devicePixelRatio || 1;
    el.width = SIZE * dpr;
    el.height = SIZE * dpr;
    ctx.scale(dpr, dpr);

    const css = getComputedStyle(document.documentElement);
    const color = (name: string) => css.getPropertyValue(name).trim();
    const accent = color("--color-accent");
    const wash = color("--color-accent-wash");
    const paper = color("--color-paper");
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Decay rather than jump, so the ring breathes instead of flickering.
    let mic = new Array(BANDS).fill(0);
    // 0 → a still circle, 1 → a floating, wobbling bubble. Eased every frame so moving
    // between states is a melt, never a snap.
    let think = 0;
    let frame = 0;
    const c = SIZE / 2;
    const R = 62;

    const draw = () => {
      // Only the patient's side. While the agent is speaking the mic mostly hears the
      // speakers (echo cancellation removes most of it), so it is ignored then too.
      const st = statusRef.current;
      const now = st === "listening" ? (session?.levels(BANDS).mic ?? []) : [];
      mic = mic.map((v, i) => Math.max(now[i] ?? 0, v * 0.86));
      const level = mic.reduce((a, b) => a + b, 0) / BANDS;

      const working = st === "thinking" || st === "connecting";
      think += ((working && !calm ? 1 : 0) - think) * 0.05;
      const t = performance.now() / 1000;

      ctx.clearRect(0, 0, SIZE, SIZE);

      // The body: a circle that swells while the patient speaks, and while the assistant is
      // working becomes a bubble — drifting up and down, turning slowly, its outline
      // rippling as three soft waves travel round it at different speeds.
      const base = R + level * 14 + think * 3;
      const cy = c + think * 7 * Math.sin(t * 1.1);
      const turn = t * 0.45;
      ctx.beginPath();
      for (let k = 0; k <= 120; k++) {
        const a = (k / 120) * Math.PI * 2;
        const ripple =
          0.06 * Math.sin(3 * a + t * 1.6) + 0.04 * Math.sin(5 * a - t * 2.1) + 0.025 * Math.sin(2 * a + t * 0.9);
        const r = base * (1 + think * ripple);
        const x = c + Math.cos(a + turn) * r;
        const y = cy + Math.sin(a + turn) * r;
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      const fill = ctx.createRadialGradient(c - base * 0.35, cy - base * 0.4, base * 0.05, c, cy, base * 1.05);
      fill.addColorStop(0, think > 0.02 ? paper : wash);
      fill.addColorStop(1, wash);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = accent;
      ctx.stroke();

      // A glint near the top, like light on a soap bubble. Only while it is a bubble.
      if (think > 0.02) {
        ctx.save();
        ctx.globalAlpha = think * 0.75;
        ctx.beginPath();
        ctx.ellipse(c - base * 0.38, cy - base * 0.42, base * 0.18, base * 0.09, -0.6, 0, Math.PI * 2);
        ctx.fillStyle = paper;
        ctx.fill();
        ctx.restore();
      }

      if (!calm) {
        // Mirrored bars all the way round.
        ctx.strokeStyle = accent;
        ctx.lineWidth = 3;
        ctx.lineCap = "round";
        for (let i = 0; i < BANDS * 2; i++) {
          const v = mic[i < BANDS ? i : BANDS * 2 - 1 - i];
          if (v < 0.02) continue;
          const a = (i / (BANDS * 2)) * Math.PI * 2 - Math.PI / 2;
          const r0 = R + 10;
          const r1 = r0 + 4 + v * 28;
          ctx.beginPath();
          ctx.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
          ctx.lineTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1);
          ctx.stroke();
        }
      }

      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [session]);

  function press() {
    if (holdTimer.current) return;
    ended.current = false;
    setHolding(true);
    holdTimer.current = setTimeout(() => {
      holdTimer.current = null;
      ended.current = true;
      setHolding(false);
      onEnd();
    }, HOLD_MS);
  }

  /** Released before the hold completed: that was a tap. */
  function release(cancelled = false) {
    if (!holdTimer.current) return;
    clearTimeout(holdTimer.current);
    holdTimer.current = null;
    setHolding(false);
    if (!cancelled && !ended.current) onInterrupt();
  }

  useEffect(() => () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
  }, []);

  // The hold ring sits just outside the bars and fills over HOLD_MS.
  const ringR = SIZE / 2 - 4;
  const circumference = 2 * Math.PI * ringR;

  return (
    <div className="flex flex-col items-center">
      <button
        type="button"
        // The button that started voice has just disappeared; land focus here instead.
        autoFocus
        aria-label="Voice assistant. Speak or press to interrupt. Press and hold to end the conversation."
        aria-describedby="orb-hint"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          press();
        }}
        onPointerUp={() => release()}
        onPointerCancel={() => release(true)}
        onKeyDown={(e) => {
          if ((e.key === " " || e.key === "Enter") && !e.repeat) {
            e.preventDefault();
            press();
          }
        }}
        onKeyUp={(e) => {
          if (e.key === " " || e.key === "Enter") release();
        }}
        onContextMenu={(e) => e.preventDefault()}
        className="relative touch-none select-none rounded-full"
        style={{ width: SIZE, height: SIZE, WebkitTouchCallout: "none" }}
      >
        <canvas ref={canvas} aria-hidden style={{ width: SIZE, height: SIZE }} />
        <svg aria-hidden className="pointer-events-none absolute inset-0" width={SIZE} height={SIZE}>
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={ringR}
            fill="none"
            stroke="var(--color-alert)"
            strokeWidth={3}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={holding ? 0 : circumference}
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
            style={{ transition: holding ? `stroke-dashoffset ${HOLD_MS}ms linear` : "none" }}
          />
        </svg>
      </button>

      <p aria-live="polite" className="mt-3 text-[14px] font-medium">
        {holding ? "Keep holding to end…" : awaitingYes ? "Waiting for your yes — or press Confirm" : LABEL[status]}
      </p>
      <p id="orb-hint" className="mt-1 text-[12px] text-muted">
        Speak or tap to interrupt · hold to end
      </p>
    </div>
  );
}
