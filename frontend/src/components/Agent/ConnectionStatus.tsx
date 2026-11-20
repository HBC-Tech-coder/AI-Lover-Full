"use client";

import { Circle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useT } from "@/lib/i18n";
import { useAgentStore } from "@/store/agentStore";

export function ConnectionStatus() {
  const { wsConnected, status } = useAgentStore();
  const t = useT();

  // Keep badge subtle regardless of state for a minimal look
  const getStatusVariant = ():
    | "default"
    | "secondary"
    | "destructive"
    | "outline" => {
    return "outline";
  };

  const getStatusColor = () => {
    if (!wsConnected) return "text-red-500";
    // When WebSocket is connected, always show green
    return "text-emerald-500";
  };

  const getStatusText = () => {
    if (!wsConnected) return t("status.disconnected");
    return t("status.connected");
  };

  return (
    <Badge
      variant={getStatusVariant()}
      className="flex items-center gap-2 px-3 py-1"
    >
      <Circle className={`h-2 w-2 fill-current ${getStatusColor()}`} />
      <span>{getStatusText()}</span>
    </Badge>
  );
}
