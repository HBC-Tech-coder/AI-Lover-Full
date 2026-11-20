"use client";

import { Mic, MicOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n";

interface AudioControlsProps {
  /** True when the mic is currently capturing audio. */
  isRecording: boolean;
  onStartRecording: () => void;
  onStopRecording: () => void;
}

/**
 * Mic toggle button. Icon shows the CURRENT state (Mic = listening,
 * MicOff = muted) to match the camera toggle and standard video-call UX.
 * Tooltip describes the click action.
 */
export function AudioControls({
  isRecording,
  onStartRecording,
  onStopRecording,
}: AudioControlsProps) {
  const t = useT();
  const label = isRecording ? t("toolbar.micOff") : t("toolbar.micOn");
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="sm"
            variant={isRecording ? "default" : "outline"}
            onClick={isRecording ? onStopRecording : onStartRecording}
            className="gap-2"
            title={label}
          >
            {isRecording ? (
              <Mic className="h-4 w-4" />
            ) : (
              <MicOff className="h-4 w-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>{label}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
