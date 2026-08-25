"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

/**
 * Submit button that knows whether its form is in flight.
 *
 * login() is a plain Server Action ending in redirect(), so there is no result
 * to render and nothing else can report progress. On a slow mobile connection
 * the button simply sat there, which reads as a dead control and invites a
 * second tap — and a second sign-in attempt.
 *
 * useFormStatus is the framework's own mechanism for this and must be called
 * from a component INSIDE the <form>, which is the only reason this is its own
 * file. No authentication behaviour changes here.
 */
export function LoginSubmit({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" disabled={pending} aria-disabled={pending}>
      {pending ? pendingLabel : label}
    </Button>
  );
}
