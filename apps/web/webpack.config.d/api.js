config.devServer = {
    ...config.devServer,
    host: '127.0.0.1',
    proxy: [{ context: ['/api'], target: 'http://127.0.0.1:3001' }],
};
