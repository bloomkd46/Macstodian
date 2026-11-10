// Explicit vendor guidance only. Never discover or execute arbitrary uninstall scripts.
// Sources and version differences are documented in README.md.
export function vendorUninstaller(bundleId: string | null): string | null {
  const id = bundleId?.toLowerCase()
  if (id?.startsWith('com.adobe.'))
    return 'Adobe supplies uninstallers through Creative Cloud and /Applications/Utilities/Adobe Installers. Use the vendor uninstaller to remove services and licensed components.'
  if (id?.startsWith('com.autodesk.'))
    return 'Autodesk supplies product removal tools alongside its applications, such as Remove AutoCAD. Follow the vendor instructions for your product; shared licensing components may serve other installed Autodesk apps.'
  if (id === 'com.rogueamoeba.soundsource')
    return 'Use SoundSource’s in-app Uninstall SoundSource command before moving its bundle to Trash (older versions: Uninstall ACE). The vendor process removes audio components that this scoped scanner does not cover.'
  return null
}
