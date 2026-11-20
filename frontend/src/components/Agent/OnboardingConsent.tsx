"use client";

/**
 * First-run consent overlay. Semi-transparent backdrop + a scrollable card
 * that explains mic/camera usage, data storage, and the pick-character /
 * switch-model features. The user must accept before using the platform;
 * acceptance is persisted in settings (consentAccepted) so it shows once.
 *
 * Renders nothing until mounted (avoids a one-frame flash for users who
 * already accepted) and nothing once consent is given.
 */

import { Database, Mic, Sparkles, Video } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { useSettings } from "@/lib/settingsStore";

export function OnboardingConsent() {
  const t = useT();
  const [settings, setSettings] = useSettings();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted || settings.consentAccepted) return null;

  const sections = [
    { icon: Mic, title: t("consent.voiceTitle"), body: t("consent.voice") },
    { icon: Video, title: t("consent.videoTitle"), body: t("consent.video") },
    {
      icon: Database,
      title: t("consent.dataTitle"),
      body: t("consent.data"),
    },
    {
      icon: Sparkles,
      title: t("consent.featuresTitle"),
      body: t("consent.features"),
    },
  ];

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border/40 bg-card/95 shadow-2xl">
        <div className="shrink-0 px-6 pt-6 pb-3">
          <h2 className="font-semibold text-foreground text-xl">
            {t("consent.title")}
          </h2>
          <p className="mt-1 text-muted-foreground text-sm">
            {t("consent.subtitle")}
          </p>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-2">
          {sections.map((sec) => {
            const Icon = sec.icon;
            return (
              <div key={sec.title} className="flex gap-3">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/15">
                  <Icon className="h-4 w-4 text-primary" />
                </div>
                <div className="min-w-0">
                  <div className="font-medium text-foreground text-sm">
                    {sec.title}
                  </div>
                  <p className="mt-0.5 text-muted-foreground text-sm leading-relaxed">
                    {sec.body}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        <div className="shrink-0 space-y-2 border-border/40 border-t px-6 pt-4 pb-6">
          <p className="rounded-md bg-amber-500/15 px-3 py-2 text-amber-600 text-xs leading-relaxed dark:text-amber-400">
            {t("consent.loadingNote")}
          </p>
          <Button
            className="w-full"
            size="lg"
            onClick={() => setSettings({ consentAccepted: true })}
          >
            {t("consent.accept")}
          </Button>
          <p className="text-center text-muted-foreground/80 text-xs">
            {t("consent.footnote")}
          </p>
        </div>
      </div>
    </div>
  );
}
