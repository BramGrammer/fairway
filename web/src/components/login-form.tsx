import { useState, type FormEvent } from "react"

import { FairwayLogo } from "@/components/fairway-logo"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"

type LoginReply = { ok: true; user: string } | { ok: false; error: string }

/** The Owner's sign in screen: a centred card on a muted background. */
export function LoginView({ onSignedIn }: { onSignedIn: () => void }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    setPending(true)
    setError(null)
    try {
      const { status, body } = await api<LoginReply>("/api/auth/login", {
        username: String(data.get("username") ?? ""),
        password: String(data.get("password") ?? ""),
      })
      if (status === 200 && body.ok) onSignedIn()
      else setError(body.ok ? "Could not sign in" : body.error)
    } catch {
      setError("Could not reach Fairway")
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex items-center gap-2 self-center font-heading font-semibold">
          <FairwayLogo className="size-8 text-primary" />
          Fairway
        </div>
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-xl">Sign in</CardTitle>
            <CardDescription>Enter your username and password to continue</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit}>
              <FieldGroup>
                <Field data-invalid={error ? true : undefined}>
                  <FieldLabel htmlFor="username">Username</FieldLabel>
                  <Input
                    id="username"
                    name="username"
                    autoComplete="username"
                    autoFocus
                    required
                    aria-invalid={error ? true : undefined}
                  />
                </Field>
                <Field data-invalid={error ? true : undefined}>
                  <FieldLabel htmlFor="password">Password</FieldLabel>
                  <Input
                    id="password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    aria-invalid={error ? true : undefined}
                  />
                </Field>
                <Field>
                  {error && <FieldError role="alert">{error}</FieldError>}
                  <Button type="submit" disabled={pending}>
                    {pending && <Spinner data-icon="inline-start" />}
                    {pending ? "Signing in" : "Sign in"}
                  </Button>
                </Field>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
