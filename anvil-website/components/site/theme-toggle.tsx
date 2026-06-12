"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

type ThemePreference = "system" | "dark" | "light";

const storageKey = "anvil-registry-theme";
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

export function ThemeToggle() {
  const [preference, setPreference] = useState<ThemePreference>("system");

  useEffect(() => {
    const stored = getStoredPreference();
    const media = window.matchMedia("(prefers-color-scheme: dark)");

    setPreference(stored);
    applyTheme(stored);

    const handleChange = () => {
      if (getStoredPreference() === "system") applyTheme("system");
    };

    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  function cyclePreference() {
    const next = preferences[(preferences.indexOf(preference) + 1) % preferences.length];
    window.localStorage.setItem(storageKey, next);
    setPreference(next);
    applyTheme(next);
  }

  const label = `Theme: ${preference}`;
  const Icon = preference === "dark" ? Moon : preference === "light" ? Sun : Monitor;

  return (
    <Button type="button" variant="outline" size="icon" aria-label={label} title={label} onClick={cyclePreference}>
      <Icon aria-hidden="true" />
    </Button>
  );
}
