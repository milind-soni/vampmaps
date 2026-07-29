module.exports = ({ config }) => {
  const manifestUrl = process.env.EXPO_PUBLIC_COVERAGE_MANIFEST_URL;
  const requestUrl = process.env.EXPO_PUBLIC_COVERAGE_REQUEST_URL;
  const releaseBuild = process.env.NODE_ENV === "production" || process.env.EAS_BUILD === "true";

  if (releaseBuild) {
    if (!manifestUrl) {
      throw new Error(
        "EXPO_PUBLIC_COVERAGE_MANIFEST_URL must be set to the production HTTPS catalog.",
      );
    }
    let parsed;
    try {
      parsed = new URL(manifestUrl);
    } catch {
      throw new Error("EXPO_PUBLIC_COVERAGE_MANIFEST_URL must be a valid absolute URL.");
    }
    if (parsed.protocol !== "https:") {
      throw new Error("EXPO_PUBLIC_COVERAGE_MANIFEST_URL must use HTTPS in production.");
    }

    if (requestUrl) {
      let parsedRequest;
      try {
        parsedRequest = new URL(requestUrl);
      } catch {
        throw new Error("EXPO_PUBLIC_COVERAGE_REQUEST_URL must be a valid absolute URL.");
      }
      if (parsedRequest.protocol !== "https:") {
        throw new Error("EXPO_PUBLIC_COVERAGE_REQUEST_URL must use HTTPS in production.");
      }
    }
  }

  return config;
};
