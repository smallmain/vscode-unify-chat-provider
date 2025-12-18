import type { UiContext, UiNavAction, UiResume, UiRoute } from './types';
import { runModelFormScreen } from '../screens/model-form-screen';
import { runModelListScreen } from '../screens/model-list-screen';
import { runModelSelectionScreen } from '../screens/model-selection-screen';
import { runProviderFormScreen } from '../screens/provider-form-screen';
import { runProviderListScreen } from '../screens/provider-list-screen';
import { runWellKnownProviderApiKeyScreen } from '../screens/well-known-provider-api-key-screen';
import { runWellKnownProviderListScreen } from '../screens/well-known-provider-list-screen';
import { runWellKnownProviderNameScreen } from '../screens/well-known-provider-name-screen';

export async function runUiStack(
  ctx: UiContext,
  initialRoute: UiRoute,
): Promise<void> {
  const stack: UiRoute[] = [initialRoute];
  let resume: UiResume | undefined;

  while (stack.length > 0) {
    const currentRoute = stack[stack.length - 1];
    const action = await dispatchRoute(ctx, currentRoute, resume);
    resume = undefined;

    switch (action.kind) {
      case 'stay':
        continue;
      case 'push':
        stack.push(action.route);
        continue;
      case 'replace':
        stack[stack.length - 1] = action.route;
        continue;
      case 'pop':
        stack.pop();
        resume = action.resume;
        continue;
      case 'popToRoot': {
        if (stack.length > 1) {
          stack.splice(1);
        } else {
          stack.pop();
        }
        resume = action.resume;
        continue;
      }
      case 'exit':
        return;
      default:
        assertNever(action);
    }
  }
}

async function dispatchRoute(
  ctx: UiContext,
  route: UiRoute,
  resume: UiResume | undefined,
): Promise<UiNavAction> {
  switch (route.kind) {
    case 'providerList':
      return runProviderListScreen(ctx, route, resume);
    case 'providerForm':
      return runProviderFormScreen(ctx, route, resume);
    case 'wellKnownProviderList':
      return runWellKnownProviderListScreen(ctx, route, resume);
    case 'wellKnownProviderName':
      return runWellKnownProviderNameScreen(ctx, route, resume);
    case 'wellKnownProviderApiKey':
      return runWellKnownProviderApiKeyScreen(ctx, route, resume);
    case 'modelList':
      return runModelListScreen(ctx, route, resume);
    case 'modelForm':
      return runModelFormScreen(ctx, route, resume);
    case 'modelSelection':
      return runModelSelectionScreen(ctx, route, resume);
    default:
      return assertNever(route);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}

