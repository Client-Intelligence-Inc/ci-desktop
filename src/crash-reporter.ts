import { app } from 'electron';

let initialized = false;

export async function initCrashReporter(): Promise<void> {
  const dsn = process.env.CI_DESKTOP_SENTRY_DSN;
  if (!dsn || initialized) return;

  try {
    const Sentry = await import('@sentry/electron/main');
    Sentry.init({
      dsn,
      release: `ci-desktop@${app.getVersion()}`,
      environment: process.env.CI_DESKTOP_SENTRY_ENV || 'production',
      enabled: app.isPackaged,
      beforeSend(event) {
        if (event.user) {
          delete event.user.ip_address;
          delete event.user.email;
        }
        return event;
      },
    });
    initialized = true;
    console.log('Crash reporter initialized');
  } catch {
    console.log('Sentry not available, crash reporting disabled');
  }
}
