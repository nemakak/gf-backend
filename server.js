      const r = await fal.subscribe(VTON_MODEL, {
        input: {
          image_urls: [humanImg, garmentUrl],
          prompt: [
            'Photorealistic virtual try-on.',
            'Preserve EXACTLY the person from the first image:',
            'same face, same facial features, same hair, same skin tone, same body proportions, same pose, same background, same lighting, same camera angle.',
            'Only replace the clothing with the garment from the second image.',
            'The garment must fit naturally on the body with realistic folds, wrinkles and shadows.',
            'Keep the fabric texture, color and pattern of the garment unchanged.',
            'Full body shot, editorial fashion photography quality, sharp focus, 4K, natural light.',
          ].join(' '),
          num_inference_steps: 50,
          guidance_scale: 3.5,
          lora_scale: 1.15,
          num_images: 1,
          output_format: 'jpeg',
        },
        logs: false,
      });
