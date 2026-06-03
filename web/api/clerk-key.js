module.exports = (req, res) => {
  const key = process.env.VITE_CLERK_PUBLISHABLE_KEY || 'pk_test_c2V0dGxpbmctamF5LTguY2xlcmsuYWNjb3VudHMuZGV2JA';
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json({ clerkPublishableKey: key });
};
