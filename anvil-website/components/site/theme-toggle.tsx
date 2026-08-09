"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";

type ThemePreference = "system" | "dark" | "light";

const storageKey = "anvil-registry-theme";
const preferenceChangeEvent = "anvil-theme-preference-change";
const preferences: ThemePreference[] = ["system", "dark", "light"];

function getStoredPreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  const stored = window.localStorage.getItem(storageKey);
  if (stored === "dark" || stored === "light" || stored === "system") return stored;
  return "system";
}

function applyTheme(preference: ThemePreference) {
  const root = document.documentElement;
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = preference === "dark" || (preference === "system" && systemDark);

  root.classList.toggle("dark", dark);
  root.dataset.theme = preference;
  root.style.colorScheme = dark ? "dark" : "light";
}

function subscribeToPreference(onStoreChange: () => void): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const handlePreferenceChange = () => {
    applyTheme(getStoredPreference());
    onStoreChange();
  };

  window.addEventListener("storage", handlePreferenceChange);
  window.addEventListener(preferenceChangeEvent, handlePreferenceChange);
  media.addEventListener("change", handlePreferenceChange);

  return () => {
    window.removeEventListener("storage", handlePreferenceChange);
    window.removeEventListener(preferenceChangeEvent, handlePreferenceChange);
    media.removeEventListener("change", handlePreferenceChange);
  };
}

export function ThemeToggle() {
  const preference = useSyncExternalStore<ThemePreference>(
    subscribeToPreference,
    getStoredPreference,
    (): ThemePreference => "system",
  );

  function cyclePreference() {
    const next = preferences[(preferences.indexOf(preference) + 1) % preferences.length];
    window.localStorage.setItem(storageKey, next);
    applyTheme(next);
    window.dispatchEvent(new Event(preferenceChangeEvent));
  }

  const label = `Theme: ${preference}`;
  const Icon = preference === "dark" ? Moon : preference === "light" ? Sun : Monitor;

  return (
    <Button type="button" variant="outline" size="icon" aria-label={label} title={label} onClick={cyclePreference}>
      <Icon aria-hidden="true" />
    </Button>
  );
}
