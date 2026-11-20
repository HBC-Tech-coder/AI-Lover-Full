"use client";

import { TrulienceAvatar } from "@trulience/react-sdk";
import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

// Runtime credentials belong in frontend/.env.local and are never committed.
export const TRULIENCE_DEMO_AVATAR_ID =
  process.env.NEXT_PUBLIC_TRULIENCE_AVATAR_ID?.trim() || "4999232223300240556";
export const TRULIENCE_DEMO_TOKEN =
  process.env.NEXT_PUBLIC_TRULIENCE_TOKEN?.trim() || "";
export const TRULIENCE_SDK_URL = "https://trulience.com/sdk/trulience.sdk.js";

interface AvatarTrulienceProps {
  /** TTS audio stream. When provided, the avatar lip-syncs to it. */
  mediaStream: MediaStream | null;
}

export function AvatarTrulience({ mediaStream }: AvatarTrulienceProps) {
  const avatarRef = useRef<TrulienceAvatar>(null);
  const [loadProgress, setLoadProgress] = useState(0);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authOk, setAuthOk] = useState(false);

  const eventCallbacks = useMemo(
    () => ({
      "auth-success": () => setAuthOk(true),
      "auth-fail": (resp: { message?: string }) =>
        setAuthError(resp?.message ?? "Trulience auth failed"),
      "load-progress": (details: { progress?: number }) => {
        if (typeof details?.progress === "number") {
          setLoadProgress(details.progress);
        }
      },
    }),
    [],
  );

  // Feed the TTS MediaStream into the avatar for lip-sync as soon as both
  // the avatar is authenticated AND we have an audio stream.
  useEffect(() => {
    if (!mediaStream || !authOk) return;
    const ref = avatarRef.current;
    if (!ref?.setMediaStream) return;
    try {
      ref.setMediaStream(mediaStream);
    } catch (err) {
      console.error("[AvatarTrulience] setMediaStream failed:", err);
    }
  }, [mediaStream, authOk]);

  return (
    <div className="relative h-full w-full overflow-hidden rounded-xl bg-black">
      <TrulienceAvatar
        url={TRULIENCE_SDK_URL}
        ref={avatarRef}
        avatarId={TRULIENCE_DEMO_AVATAR_ID}
        token={TRULIENCE_DEMO_TOKEN}
        eventCallbacks={eventCallbacks}
        width="100%"
        height="100%"
      />

      {/* Loading / error overlay */}
      {loadProgress < 1 && !authError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60 text-white">
          <Loader2 className="h-6 w-6 animate-spin" />
          <div className="text-sm">
            Loading avatar… {Math.round(loadProgress * 100)}%
          </div>
        </div>
      )}
      {authError && (
        <div className="absolute inset-0 flex items-center justify-center bg-red-900/80 p-4 text-center text-sm text-white">
          Avatar error: {authError}
        </div>
      )}
    </div>
  );
}
