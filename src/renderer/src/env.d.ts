import type { MacstodianAPI } from '../../shared/api'
declare global {
  interface Window {
    macstodian: MacstodianAPI
  }
}
