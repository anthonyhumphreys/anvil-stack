const { withAndroidManifest } = require('expo/config-plugins');

/** Private IP hosts use authenticated E2EE frames over HTTP/WS. The client separately
 * restricts those origins; broker credentials always require HTTPS. Android's static
 * domain rules cannot express dynamically discovered private IP subnets. */
module.exports = function withAnvilMeshNetworking(config) {
  return withAndroidManifest(config, (next) => {
    const application = next.modResults.manifest.application?.[0];
    if (application) {
      application.$ = application.$ || {};
      application.$['android:usesCleartextTraffic'] = 'true';
    }
    return next;
  });
};
